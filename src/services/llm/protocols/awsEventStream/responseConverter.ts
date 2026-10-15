/**
 * OpenAI SSE → AWS EventStream binary conversion
 * Ported from 9router's kiro MITM handler
 */

import { buildEventStreamFrame, withInitialFrame, type EventType } from './frameBuilder.js';

export interface KiroConverterState {
  modelId: string | null;
  toolCallInit: Record<number, { id: string; name: string }>;
  hasToolCalls: boolean;
  finishSent: boolean;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  inThink: boolean;
  thinkBuf: string;
  initialSent: boolean;
}

export function initKiroState(modelId: string | null): KiroConverterState {
  return {
    modelId,
    toolCallInit: {},
    hasToolCalls: false,
    finishSent: false,
    usage: null,
    inThink: false,
    thinkBuf: '',
    initialSent: false,
  };
}

/**
 * Extract thinking blocks from text content.
 * Handles both <thinking>...</thinking> and 思考...思考 tags,
 * including partial tags split across SSE chunks.
 */
function extractThinking(text: string, state: KiroConverterState): { thinking: string | null; text: string | null } {
  if (!text) return { thinking: null, text: null };

  let working = text;

  // Prepend buffered partial thinking from previous chunk
  if (state.inThink && state.thinkBuf) {
    working = state.thinkBuf + working;
    state.thinkBuf = '';
    state.inThink = false;
  }

  // Match <thinking> or 思考 opening tags
  const startRe = /<thinking>|思考/i;
  const startMatch = working.match(startRe);

  if (!startMatch) {
    return { thinking: null, text: working };
  }

  const tag = startMatch[0].toLowerCase();
  const closeTag = tag === '思考' ? '思考' : '</thinking>';
  const startIdx = startMatch.index!;
  const endIdx = working.indexOf(closeTag, startIdx + tag.length);

  if (endIdx === -1) {
    // Opening tag without closing — buffer for next chunk
    state.inThink = true;
    state.thinkBuf = working.slice(startIdx);
    const before = working.slice(0, startIdx).trim();
    return { thinking: null, text: before || null };
  }

  // Complete block found
  const thinking = working.slice(startIdx + tag.length, endIdx);
  const before = working.slice(0, startIdx).trim();
  const after = working.slice(endIdx + closeTag.length).trim();
  const rest = [before, after].filter(Boolean).join('');

  // Recursively process for more blocks
  const recurse = rest
    ? extractThinking(rest, { inThink: false, thinkBuf: '', modelId: null, toolCallInit: {}, hasToolCalls: false, finishSent: false, usage: null, initialSent: false })
    : { thinking: null, text: null };

  return {
    thinking: thinking || null,
    text: recurse.text || null,
  };
}

/**
 * Convert an OpenAI SSE chunk to AWS EventStream binary frame(s)
 *
 * @param chunk - Parsed OpenAI chat.completion.chunk, or null for flush
 * @param state - Mutable state object
 * @returns Binary EventStream frame(s) or null to skip
 */
export function convertOpenAIToKiro(
  chunk: Record<string, unknown> | null,
  state: KiroConverterState
): Uint8Array | Uint8Array[] | null {
  // Flush: ensure clean stream termination
  if (!chunk) {
    if (state.finishSent) return null;
    // Flush any remaining buffered thinking
    if (state.inThink && state.thinkBuf) {
      state.inThink = false;
      const thinking = state.thinkBuf;
      state.thinkBuf = '';
      return withInitialFrame(state, buildEventStreamFrame('reasoningContentEvent', {
        content: thinking,
        modelId: state.modelId || 'kiro-unknown',
      }));
    }
    return withInitialFrame(state, buildEventStreamFrame('messageStopEvent', {}));
  }

  const frames: Uint8Array[] = [];
  const choice = (chunk.choices as unknown[])?.[0] as Record<string, unknown> | undefined;
  const delta = (choice?.delta as Record<string, unknown>) || {};

  // Capture modelId from first chunk (real API includes it in every content frame)
  if (!state.modelId && chunk.model) {
    state.modelId = chunk.model as string;
  }
  const modelId = state.modelId || 'unknown';

  // Handle usage (may arrive standalone or with other chunks)
  if (chunk.usage) {
    state.usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number };
  }

  // Handle tool calls — stream incrementally, matching real API format
  if (delta.tool_calls) {
    state.hasToolCalls = true;
    for (const tc of delta.tool_calls as unknown[]) {
      const tcRec = tc as Record<string, unknown>;
      const idx = (tcRec.index as number) ?? 0;

      if (tcRec.id && tcRec.function?.name && !state.toolCallInit[idx]) {
        // First appearance: emit frame with name + id, no input
        state.toolCallInit[idx] = { id: tcRec.id as string, name: tcRec.function.name as string };
        frames.push(buildEventStreamFrame('toolUseEvent', {
          name: tcRec.function.name,
          toolUseId: tcRec.id,
        }));
      }

      // Emit incremental input fragment
      if (tcRec.function?.arguments) {
        const init = state.toolCallInit[idx];
        frames.push(buildEventStreamFrame('toolUseEvent', {
          input: tcRec.function.arguments,
          name: init?.name || tcRec.function?.name || '',
          toolUseId: init?.id || tcRec.id || '',
        }));
      }
    }
  }

  // Handle explicit reasoning_content (type-specific thinking channel)
  if (delta.reasoning_content) {
    frames.push(buildEventStreamFrame('reasoningContentEvent', {
      content: delta.reasoning_content,
      modelId,
    }));
  }

  // Handle text content — extract thinking blocks, emit rest as assistantResponseEvent
  if (delta.content) {
    const { thinking, text } = extractThinking(delta.content as string, state);

    if (thinking) {
      frames.push(buildEventStreamFrame('reasoningContentEvent', {
        content: thinking,
        modelId,
      }));
    }

    if (text) {
      frames.push(buildEventStreamFrame('assistantResponseEvent', {
        content: text,
        modelId,
      }));
    }
  }

  // Handle finish_reason
  if (choice?.finish_reason) {
    const finishFrames = emitFinish(state);
    if (finishFrames) {
      frames.push(...(Array.isArray(finishFrames) ? finishFrames : [finishFrames]));
    }
  }

  if (frames.length === 0) {
    // First chunk might be just role/empty — send initial there
    if (!state.initialSent) return withInitialFrame(state, null);
    return null;
  }
  return withInitialFrame(state, frames.length === 1 ? frames[0] : frames);
}

/**
 * Emit termination frames. For tool-call responses, emits stop:true per tool.
 * For text-only responses, emits messageStopEvent.
 */
function emitFinish(state: KiroConverterState): Uint8Array | Uint8Array[] | null {
  const frames: Uint8Array[] = [];

  if (state.hasToolCalls) {
    // Tool-call response: emit stop:true for each tool
    for (const idx of Object.keys(state.toolCallInit).sort((a, b) => Number(a) - Number(b))) {
      const tc = state.toolCallInit[Number(idx)];
      frames.push(buildEventStreamFrame('toolUseEvent', {
        name: tc.name,
        stop: true,
        toolUseId: tc.id,
      }));
    }
  } else {
    // Text-only response: emit messageStopEvent
    frames.push(buildEventStreamFrame('messageStopEvent', {}));
  }
  state.finishSent = true;

  // Emit usage if available
  if (state.usage) {
    frames.push(buildEventStreamFrame('usageEvent', {
      inputTokens: state.usage.prompt_tokens || 0,
      outputTokens: state.usage.completion_tokens || 0,
    }));
  }

  state.toolCallInit = {};
  return frames.length > 0 ? frames : null;
}