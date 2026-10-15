/**
 * AWS EventStream Protocol Handler for Kiro (CodeWhisperer Streaming)
 *
 * Verified against kiro-cli binary + live API capture:
 * - Endpoint: https://q.{region}.amazonaws.com/ (POST /)
 * - Header: x-amzn-kiro-profile-arn
 * - Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
 * - Request: JSON; conversationState.chatTriggerType = "MANUAL" is REQUIRED
 * - Response: application/vnd.amazon.eventstream binary frames
 *
 * Strict wire rules (from 9router's canonicalizer, battle-tested against the API):
 * - alternating user/assistant turns; first and last must be user
 * - tool specs belong ONLY on the currentMessage (not on history turns)
 * - tool use/result pairs must be adjacent and 1:1; invalid pairs flatten to text
 * - tool names ∈ [a-zA-Z0-9_-] (≤64), tool IDs ∈ [a-zA-Z0-9_-] (≤64, unique)
 * - root schema must be { type: "object", properties }; no additionalProperties
 * - every turn content must be non-empty (placeholders)
 * - system prompt travels inside the first user turn content, NOT as a
 *   top-level `systemPrompt` (rejected with 400 REQUEST_BODY_INVALID)
 */

import type { LLMRoute } from '../../types.js';
import type { LLMRequest } from '../../runtime/types.js';
import type {
  StreamEvent,
  AssistantMessage,
  SystemAPIErrorMessage,
} from '../../../../types/message.js';
import type { AgentContentBlock } from '../../../../types/agentMessage.js';
import type { AgentId } from '../../../../types/ids.js';
import { APIUserAbortError } from '@anthropic-ai/sdk/error';
import { randomUUID } from 'crypto';
import { httpRequest } from '../../transport/http.js';
import { requestWithRetry } from '../../transport/retryHttpRequest.js';
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../../../utils/messages.js';
import { logForDebugging } from '../../../../utils/debug.js';
import { isAbortError } from '../../../../utils/errors.js';
import { toolToAPISchema } from '../../../../utils/api.js';
import {
  agentMessagesToOpenAIChatMessages,
  type OpenAIChatMessage,
  type OpenAIChatNormalizedUsage,
  type OpenAIChatStreamEvent,
} from '../openaiChatWire.js';
import {
  getValidKiroAccessToken,
  getKiroProfileArn,
  getKiroRegion,
} from '../../../../utils/auth.js';

export type ProtocolHandler = (
  route: LLMRoute,
  request: LLMRequest,
) => AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>;

// ─────────────────────────────────────────────────────────────────────────────
// EventStream binary frame parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedEventStreamFrame {
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Parse AWS EventStream binary frames from a byte buffer.
 * Returns parsed frames + remaining unconsumed bytes (partial frame).
 */
function parseEventStreamFrames(data: Uint8Array): {
  frames: ParsedEventStreamFrame[];
  remaining: Uint8Array;
} {
  const frames: ParsedEventStreamFrame[] = [];
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset + 12 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset, data.length - offset);
    const totalLen = view.getUint32(0, false);
    const headersLen = view.getUint32(4, false);

    if (totalLen < 12 || headersLen > totalLen || offset + totalLen > data.length) {
      break; // Incomplete or malformed frame — wait for more bytes
    }

    const headersEnd = offset + 12 + headersLen;
    const payloadStart = headersEnd;
    const payloadEnd = offset + totalLen - 4;

    // Parse headers
    const headersData = data.slice(offset + 12, headersEnd);
    let hOffset = 0;
    let eventType = '';

    while (hOffset < headersData.length) {
      const nameLen = headersData[hOffset++];
      if (hOffset + nameLen + 3 > headersData.length) break;
      const name = decoder.decode(headersData.slice(hOffset, hOffset + nameLen));
      hOffset += nameLen;
      hOffset++; // type byte (7 = string)
      const valueLen = new DataView(
        headersData.buffer,
        headersData.byteOffset + hOffset,
        2,
      ).getUint16(0, false);
      hOffset += 2;
      if (hOffset + valueLen > headersData.length) break;
      const value = decoder.decode(headersData.slice(hOffset, hOffset + valueLen));
      hOffset += valueLen;

      if (name === ':event-type') eventType = value;
    }

    // Parse payload
    let payload: Record<string, unknown> = {};
    if (payloadEnd > payloadStart) {
      try {
        payload = JSON.parse(decoder.decode(data.slice(payloadStart, payloadEnd)));
      } catch {
        // Ignore payload parse errors (unknown frame shapes)
      }
    }

    frames.push({ eventType, payload });
    offset += totalLen;
  }

  return { frames, remaining: data.slice(offset) };
}

/** Async generator: ReadableStream<Uint8Array> → parsed EventStream frames. */
async function* parseEventStreamBody(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedEventStreamFrame, void> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;

      const { frames, remaining } = parseEventStreamFrames(buffer);
      buffer = remaining;
      for (const frame of frames) yield frame;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI chat messages → CodeWhisperer conversationState
// ─────────────────────────────────────────────────────────────────────────────

const KIRO_IMAGE_FORMAT_BY_MIME = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

// Strict Kiro wire limits (mirrors 9router open-sse/config/kiroConstants.js)
const KIRO_TOOL_NAME_MAX_LENGTH = 64;
const KIRO_TOOL_DESCRIPTION_MAX_LENGTH = 10237;
const KIRO_TOOL_ID_MAX_LENGTH = 64;
const KIRO_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Placeholders for empty turns. Kiro rejects user turns with empty `content`,
 * so a turn that only carries tool results needs placeholder text. It must not
 * read like a user instruction ("continue" makes models answer the word
 * itself), so tool-result turns get a neutral sentence.
 */
const KIRO_TOOL_RESULTS_PLACEHOLDER = 'Tool results provided.';
const KIRO_EMPTY_USER_PLACEHOLDER = 'continue';

type OpenAIToolResultMessage = OpenAIChatMessage & { role: 'tool'; tool_call_id?: string };
type OpenAIAssistantMessage = OpenAIChatMessage & {
  role: 'assistant';
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

// ─── Small helpers ──────────────────────────────────────────────────────────

/** Extract plain text from OpenAI message content (string | parts array). */
function openAIContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string') return p.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Extract Kiro image entries (format + base64 bytes) from OpenAI content parts. */
function openAIContentToKiroImages(content: unknown): Array<{ format: string; source: { bytes: string } }> {
  if (!Array.isArray(content)) return [];
  const images: Array<{ format: string; source: { bytes: string } }> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if (p.type !== 'image_url') continue;
    const url = (p.image_url as Record<string, unknown> | undefined)?.url;
    if (typeof url !== 'string') continue;
    const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(url);
    if (!match) continue;
    const format = KIRO_IMAGE_FORMAT_BY_MIME.get(match[1].toLowerCase());
    if (!format) continue;
    images.push({ format, source: { bytes: match[2] } });
  }
  return images;
}

/** Safe JSON parse for tool_call arguments (OpenAI stores them as string). */
function parseToolArguments(args: unknown): unknown {
  if (args == null) return {};
  if (typeof args === 'object') return args;
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return {};
}

function trimCodePoints(value: string, limit: number): string {
  return [...String(value || '')].slice(0, limit).join('');
}

// ─── Tool spec sanitization (Kiro rejects non-conforming names/schemas) ─────

function sanitizeToolName(rawName: string | undefined, index: number, usedNames: Set<string>): string {
  const cleaned = String(rawName || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = trimCodePoints(cleaned || `tool_${index + 1}`, KIRO_TOOL_NAME_MAX_LENGTH);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, KIRO_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function sanitizeToolId(
  value: unknown,
  turnIndex: number,
  callIndex: number,
  name: string,
  usedIds: Set<string>,
): string {
  const raw = typeof value === 'string' ? value : '';
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  const generated = `call_msg${turnIndex}_tc${callIndex}_${name || 'tool'}`;
  const base = trimCodePoints(
    KIRO_TOOL_ID_PATTERN.test(sanitized) && sanitized ? sanitized : generated,
    KIRO_TOOL_ID_MAX_LENGTH,
  );
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, KIRO_TOOL_ID_MAX_LENGTH - tail.length)}${tail}`;
  }
  usedIds.add(candidate);
  return candidate;
}

/** Recursively drop `additionalProperties` and empty `required` arrays. */
function cleanSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchemaValue);
  if (!value || typeof value !== 'object') return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'additionalProperties') continue;
    if (key === 'required' && Array.isArray(child) && child.length === 0) continue;
    cleaned[key] = cleanSchemaValue(child);
  }
  return cleaned;
}

/** Kiro requires an object root schema with `properties`; `required` ⊆ properties. */
function normalizeRootSchema(schema: unknown): Record<string, unknown> {
  const cloned =
    schema && typeof schema === 'object'
      ? (JSON.parse(JSON.stringify(schema)) as Record<string, unknown>)
      : {};
  const cleaned = cleanSchemaValue(cloned) as Record<string, unknown>;
  cleaned.type = 'object';
  if (
    !cleaned.properties ||
    typeof cleaned.properties !== 'object' ||
    Array.isArray(cleaned.properties)
  ) {
    cleaned.properties = {};
  }
  if (Array.isArray(cleaned.required)) {
    const props = cleaned.properties as Record<string, unknown>;
    cleaned.required = [
      ...new Set(
        (cleaned.required as unknown[]).filter(
          (name): name is string => typeof name === 'string' && Object.hasOwn(props, name),
        ),
      ),
    ];
    if ((cleaned.required as string[]).length === 0) delete cleaned.required;
  }
  return cleaned;
}

interface KiroToolSpec {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

/**
 * Normalize tool schemas into Kiro tool specs with sanitized unique names.
 * Returns the specs + a map from original name → sanitized name.
 */
function normalizeKiroToolSpecs(
  toolSchemas: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
): { specs: KiroToolSpec[]; nameMap: Map<string, string> } {
  const specs: KiroToolSpec[] = [];
  const nameMap = new Map<string, string>();
  const usedNames = new Set<string>();

  toolSchemas.forEach((tool, index) => {
    const rawName = tool.name;
    if (typeof rawName !== 'string' || !rawName.trim()) return;
    if (nameMap.has(rawName)) return; // duplicate definitions describe the same tool
    const name = sanitizeToolName(rawName, index, usedNames);
    nameMap.set(rawName, name);

    const description = trimCodePoints(
      String(tool.description || `Tool: ${rawName}`),
      KIRO_TOOL_DESCRIPTION_MAX_LENGTH,
    );
    specs.push({
      toolSpecification: {
        name,
        description,
        inputSchema: { json: normalizeRootSchema(tool.input_schema) },
      },
    });
  });

  return { specs, nameMap };
}

// ─── Turn model (intermediate representation before canonicalization) ───────

interface UserTurn {
  kind: 'user';
  content: string;
  images: Array<{ format: string; source: { bytes: string } }>;
  toolResults: Array<Record<string, unknown>>;
}

interface AssistantTurn {
  kind: 'assistant';
  content: string;
  toolUses: Array<{ rawId: string; name: string; input: unknown }>;
}

type Turn = UserTurn | AssistantTurn;

function toolResultText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content)
    ? (result.content as Array<Record<string, unknown>>)
        .map(part => String(part?.text ?? ''))
        .filter(Boolean)
        .join('\n')
    : String(result.content ?? '');
  return `[Tool result${result.status === 'error' ? ' (error)' : ''}: ${content}]`;
}

function toolCallText(call: { name: string; input: unknown }): string {
  let input = '';
  try {
    input = JSON.stringify(call.input ?? {});
  } catch {
    input = '{}';
  }
  return `[Tool call: ${call.name || 'unknown'}(${input})]`;
}

function mergeUserTurn(target: UserTurn, source: UserTurn): void {
  if (source.content) {
    target.content = target.content ? `${target.content}\n\n${source.content}` : source.content;
  }
  if (source.images.length > 0) target.images.push(...source.images);
  if (source.toolResults.length > 0) target.toolResults.push(...source.toolResults);
}

function mergeAssistantTurn(target: AssistantTurn, source: AssistantTurn): void {
  if (source.content) {
    target.content = target.content ? `${target.content}\n\n${source.content}` : source.content;
  }
  if (source.toolUses.length > 0) target.toolUses.push(...source.toolUses);
}

/** OpenAI chat messages → raw turns (merging consecutive same-role turns). */
function openAIMessagesToTurns(openaiMessages: OpenAIChatMessage[]): Turn[] {
  const turns: Turn[] = [];

  const pushUser = (turn: UserTurn): void => {
    const prev = turns[turns.length - 1];
    if (prev?.kind === 'user') mergeUserTurn(prev, turn);
    else turns.push(turn);
  };
  const pushAssistant = (turn: AssistantTurn): void => {
    const prev = turns[turns.length - 1];
    if (prev?.kind === 'assistant') mergeAssistantTurn(prev, turn);
    else turns.push(turn);
  };

  let pendingToolResults: Array<Record<string, unknown>> = [];

  for (const msg of openaiMessages) {
    const role = msg.role;

    if (role === 'system') continue; // system prompt travels in first user turn content

    if (role === 'tool') {
      const toolMsg = msg as OpenAIToolResultMessage;
      pendingToolResults.push({
        toolUseId: toolMsg.tool_call_id || '',
        status: 'success',
        content: [{ text: openAIContentToText(toolMsg.content) }],
      });
      continue;
    }

    if (role === 'user') {
      pushUser({
        kind: 'user',
        content: openAIContentToText(msg.content),
        images: openAIContentToKiroImages(msg.content),
        toolResults: pendingToolResults,
      });
      pendingToolResults = [];
      continue;
    }

    if (role === 'assistant') {
      // Tool results arriving before an assistant turn belong to a standalone
      // user turn (stale pairing) — flush them as their own turn.
      if (pendingToolResults.length > 0) {
        pushUser({ kind: 'user', content: '', images: [], toolResults: pendingToolResults });
        pendingToolResults = [];
      }
      const assistantMsg = msg as OpenAIAssistantMessage;
      pushAssistant({
        kind: 'assistant',
        content: openAIContentToText(assistantMsg.content),
        toolUses: (assistantMsg.tool_calls || []).map(tc => ({
          rawId: tc.id || '',
          name: tc.function?.name || '',
          input: parseToolArguments(tc.function?.arguments),
        })),
      });
      continue;
    }
  }

  // Trailing tool results: they become (part of) the current user turn
  if (pendingToolResults.length > 0) {
    pushUser({ kind: 'user', content: '', images: [], toolResults: pendingToolResults });
  }

  return turns;
}

/** Normalize a tool result for the wire (content parts must be `{ text }`). */
function normalizeToolResult(result: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(result.content)
    ? (result.content as Array<Record<string, unknown>>).map(part => ({
        text: String(part?.text ?? ''),
      }))
    : [{ text: String(result.content ?? '') }];
  return {
    toolUseId: typeof result.toolUseId === 'string' ? result.toolUseId : '',
    status: result.status === 'error' ? 'error' : 'success',
    content: content.length > 0 ? content : [{ text: '' }],
  };
}

/**
 * Canonicalize turns to Kiro's strict wire rules:
 * - alternating user/assistant turns (first + last must be user)
 * - adjacent 1:1 tool use/result pairing; invalid pairs flattened to text
 * - tool names sanitized + tool IDs sanitized/unique
 * - non-empty content on every turn (placeholders)
 */
function canonicalizeTurns(
  turns: Turn[],
  modelId: string,
  nameMap: Map<string, string>,
  specNames: Set<string>,
): { history: Array<Record<string, unknown>>; currentMessage: Record<string, unknown> } {
  // Ensure alternation with user turns at both ends
  const alternating: Turn[] = [];
  for (const turn of turns) {
    const prev = alternating[alternating.length - 1];
    if (prev && prev.kind === turn.kind) {
      if (turn.kind === 'user') mergeUserTurn(prev as UserTurn, turn as UserTurn);
      else mergeAssistantTurn(prev as AssistantTurn, turn as AssistantTurn);
    } else {
      alternating.push(turn);
    }
  }
  if (alternating.length === 0 || alternating[0].kind === 'assistant') {
    alternating.unshift({
      kind: 'user',
      content: KIRO_EMPTY_USER_PLACEHOLDER,
      images: [],
      toolResults: [],
    });
  }
  if (alternating[alternating.length - 1].kind === 'assistant') {
    alternating.push({
      kind: 'user',
      content: KIRO_EMPTY_USER_PLACEHOLDER,
      images: [],
      toolResults: [],
    });
  }

  const usedIds = new Set<string>();
  const wireTurns: Array<Record<string, unknown>> = [];

  for (let i = 0; i < alternating.length; i++) {
    const turn = alternating[i];

    if (turn.kind === 'user') {
      const isEmpty = !turn.content.trim();
      const content = isEmpty
        ? turn.toolResults.length > 0
          ? KIRO_TOOL_RESULTS_PLACEHOLDER
          : KIRO_EMPTY_USER_PLACEHOLDER
        : turn.content.trim();

      const userInputMessage: Record<string, unknown> = {
        content,
        modelId,
      };
      if (turn.images.length > 0) userInputMessage.images = turn.images;
      if (turn.toolResults.length > 0) {
        userInputMessage.userInputMessageContext = {
          toolResults: turn.toolResults.map(normalizeToolResult),
        };
      }
      wireTurns.push({ userInputMessage });
      continue;
    }

    // Assistant turn: reconcile tool uses with the following user turn's results
    const nextUser = alternating[i + 1]?.kind === 'user' ? (alternating[i + 1] as UserTurn) : null;
    const incomingResults = (nextUser?.toolResults ?? []).map(normalizeToolResult);
    const resultById = new Map<string, Record<string, unknown>>();
    for (const r of incomingResults) {
      const key = String(r.toolUseId);
      if (!resultById.has(key)) resultById.set(key, r);
    }

    const keptCalls: Array<Record<string, unknown>> = [];
    const keptResults: Array<Record<string, unknown>> = [];
    const flattenedLines: string[] = [];

    for (const [callIndex, call] of turn.toolUses.entries()) {
      const mappedName = nameMap.get(call.name) || call.name;
      const inputOk = call.input && typeof call.input === 'object' && !Array.isArray(call.input);
      const result = resultById.get(call.rawId);
      const hasSpec = specNames.has(mappedName);

      if (!inputOk || !hasSpec || !result) {
        // Invalid call — flatten to text; its result (if any) gets flattened too
        flattenedLines.push(toolCallText({ name: mappedName, input: call.input }));
        if (result) {
          flattenedLines.push(toolResultText(result));
          resultById.delete(String(result.toolUseId));
        }
        continue;
      }

      const toolUseId = sanitizeToolId(call.rawId, i, callIndex, mappedName, usedIds);
      keptCalls.push({ toolUseId, name: mappedName, input: call.input });
      keptResults.push({ ...result, toolUseId });
      resultById.delete(String(result.toolUseId));
    }

    // Orphan results (no matching call) get flattened to text
    for (const r of resultById.values()) {
      flattenedLines.push(toolResultText(r));
    }

    const content = [turn.content.trim() || '...', ...flattenedLines].filter(Boolean).join('\n\n');

    const assistantResponseMessage: Record<string, unknown> = { content };
    if (keptCalls.length > 0) assistantResponseMessage.toolUses = keptCalls;
    wireTurns.push({ assistantResponseMessage });

    // The paired user turn carries ONLY the kept (sanitized) results.
    // Invalid/orphan results were already flattened into the assistant text.
    if (nextUser) {
      nextUser.toolResults = keptResults;
    }
  }

  // Last wire turn is currentMessage; ensure it is a user turn
  let currentMessage = wireTurns.pop() as Record<string, unknown> | undefined;
  if (!currentMessage || !currentMessage.userInputMessage) {
    if (currentMessage) wireTurns.push(currentMessage);
    currentMessage = {
      userInputMessage: {
        content: KIRO_EMPTY_USER_PLACEHOLDER,
        modelId,
      },
    };
  }

  return { history: wireTurns, currentMessage };
}

/**
 * Convert OpenAI chat messages (already normalized from codev messages)
 * + tool schemas → CodeWhisperer conversationState.
 *
 * Shape:
 *   conversationState: {
 *     conversationId: uuid,
 *     chatTriggerType: 'MANUAL',           // REQUIRED
 *     history: [ { userInputMessage } | { assistantResponseMessage } ... ],
 *     currentMessage: { userInputMessage: { content, modelId, context } },
 *   }
 *
 * `systemPrompt` is folded into the first user turn's content — the surface
 * rejects a top-level `systemPrompt` field with 400 REQUEST_BODY_INVALID.
 * Tool specs are attached ONLY to the currentMessage.
 */
export function buildConversationState(
  openaiMessages: OpenAIChatMessage[],
  toolSchemas: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
  options?: { modelId?: string; systemPrompt?: string },
): Record<string, unknown> {
  const modelId = options?.modelId || 'auto';
  const { specs, nameMap } = normalizeKiroToolSpecs(toolSchemas);
  const specNames = new Set(specs.map(s => s.toolSpecification.name));

  const turns = openAIMessagesToTurns(openaiMessages);

  // Fold the system prompt into the first user turn (content prefix)
  const systemText = (options?.systemPrompt || '').trim();
  if (systemText) {
    const firstUser = turns.find(t => t.kind === 'user') as UserTurn | undefined;
    if (firstUser) {
      firstUser.content = firstUser.content
        ? `${systemText}\n\n${firstUser.content}`
        : systemText;
    } else {
      turns.unshift({ kind: 'user', content: systemText, images: [], toolResults: [] });
    }
  }

  const { history, currentMessage } = canonicalizeTurns(turns, modelId, nameMap, specNames);

  // Tool specs go ONLY on the currentMessage
  const currentUim = currentMessage.userInputMessage as Record<string, unknown>;
  if (specs.length > 0) {
    const context = (currentUim.userInputMessageContext as Record<string, unknown> | undefined) ?? {};
    context.tools = specs;
    currentUim.userInputMessageContext = context;
  }
  // Drop an empty context object (keeps the wire shape clean)
  const ctx = currentUim.userInputMessageContext as Record<string, unknown> | undefined;
  if (ctx && Object.keys(ctx).length === 0) delete currentUim.userInputMessageContext;

  return {
    conversationId: randomUUID(),
    chatTriggerType: 'MANUAL',
    history,
    currentMessage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EventStream frames → internal stream events (OpenAIChatStreamEvent grammar)
// ─────────────────────────────────────────────────────────────────────────────

type BlockKind = 'thinking' | 'text' | 'tool_use';

/**
 * Adapt parsed Kiro EventStream frames into the OpenAIChatStreamEvent grammar
 * that the runtime already consumes (message_start / content_block_* /
 * message_delta / message_stop).
 *
 * Kiro's stream is a flat sequence of typed frames; content may interleave
 * (thinking → text → tool uses). We synthesize block boundaries.
 */
async function* adaptKiroEventStream(
  frames: AsyncIterable<ParsedEventStreamFrame>,
  model: string,
): AsyncGenerator<OpenAIChatStreamEvent, void> {
  let started = false;
  let nextIndex = 0;
  let current: { kind: BlockKind; index: number } | null = null;
  let sawStop = false;
  let usage: OpenAIChatNormalizedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  function* ensureStarted(): Generator<OpenAIChatStreamEvent, void> {
    if (started) return;
    started = true;
    yield {
      type: 'message_start',
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage },
      },
    };
  }

  function* closeCurrent(): Generator<OpenAIChatStreamEvent, void> {
    if (!current) return;
    yield* ensureStarted();
    yield { type: 'content_block_stop', index: current.index };
    current = null;
  }

  function* openBlock(kind: BlockKind): Generator<OpenAIChatStreamEvent, void> {
    yield* closeCurrent();
    yield* ensureStarted();
    const index = nextIndex++;
    current = { kind, index };
    if (kind === 'thinking') {
      yield {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      };
    } else if (kind === 'text') {
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
    }
    // tool_use blocks are opened by toolUseEvent (they carry id + name)
  }

  for await (const frame of frames) {
    const { eventType, payload } = frame;

    switch (eventType) {
      case 'initial-response':
        break;

      case 'assistantResponseEvent': {
        const content = payload.content;
        if (typeof content === 'string' && content.length > 0) {
          if (current?.kind !== 'text') {
            yield* openBlock('text');
          }
          yield {
            type: 'content_block_delta',
            index: current!.index,
            delta: { type: 'text_delta', text: content },
          };
        }
        break;
      }

      case 'reasoningContentEvent': {
        const thinking = payload.content ?? payload.reasoningContent ?? payload.text;
        if (typeof thinking === 'string' && thinking.length > 0) {
          if (current?.kind !== 'thinking') {
            yield* openBlock('thinking');
          }
          yield {
            type: 'content_block_delta',
            index: current!.index,
            delta: { type: 'thinking_delta', thinking },
          };
        }
        break;
      }

      case 'toolUseEvent': {
        if (payload.stop === true) {
          // Tool input stream finished
          if (current?.kind === 'tool_use') {
            yield* closeCurrent();
          }
          break;
        }
        if (typeof payload.input === 'string') {
          // Incremental input fragment on the active tool block
          if (current?.kind !== 'tool_use') break; // out-of-order; ignore
          yield {
            type: 'content_block_delta',
            index: current.index,
            delta: { type: 'input_json_delta', partial_json: payload.input },
          };
          break;
        }
        if (payload.name && payload.toolUseId) {
          // New tool use
          yield* closeCurrent();
          yield* ensureStarted();
          const index = nextIndex++;
          current = { kind: 'tool_use', index };
          yield {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: payload.toolUseId as string,
              name: payload.name as string,
              input: {},
            },
          };
        }
        break;
      }

      case 'usageEvent': {
        usage = {
          ...usage,
          input_tokens: (payload.inputTokens as number) ?? usage.input_tokens,
          output_tokens: (payload.outputTokens as number) ?? usage.output_tokens,
        };
        break;
      }

      case 'meteringEvent': {
        // { unit, unitPlural, usage } — credit metering, not tokens. Ignored.
        break;
      }

      case 'contextUsageEvent':
      case 'codeReferenceEvent':
      case 'supplementaryWebLinksEvent':
      case 'messageMetadataEvent':
      case 'followupPromptEvent':
        break;

      case 'messageStopEvent': {
        if (!sawStop) {
          sawStop = true;
          yield* closeCurrent();
          yield* ensureStarted();
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { ...usage },
          };
          yield { type: 'message_stop' };
        }
        break;
      }

      case 'invalidStateEvent': {
        const reason = (payload.reason as string) || (payload.message as string);
        if (reason === 'INVALID_TASK_ASSIST_PLAN') break; // benign in IDE flows
        yield* closeCurrent();
        yield* ensureStarted();
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { ...usage },
        };
        yield { type: 'message_stop' };
        break;
      }

      case 'exception':
      case 'error': {
        const message =
          (payload.message as string) ||
          (payload.reason as string) ||
          `Kiro stream error (${eventType})`;
        throw new Error(message);
      }

      default:
        // Forward-compatible: ignore unknown event types
        break;
    }
  }

  // Stream ended without an explicit messageStopEvent — close out cleanly
  if (started && !sawStop) {
    yield* closeCurrent();
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { ...usage },
    };
    yield { type: 'message_stop' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main protocol handler
// ─────────────────────────────────────────────────────────────────────────────

export async function* queryAWSEventStream(
  route: LLMRoute,
  request: LLMRequest,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal, context } = request;
  let partialMessage:
    | Extract<OpenAIChatStreamEvent, { type: 'message_start' }>['message']
    | null = null;
  let ttftMs = 0;
  const start = Date.now();
  let usage: OpenAIChatNormalizedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let stopReason: string | null = null;

  try {
    const model = route.model;
    const region = getKiroRegion() || 'us-east-1';
    const baseUrl =
      process.env.KIRO_BASE_URL?.replace(/\/$/, '') ?? `https://q.${region}.amazonaws.com`;
    const endpoint = `${baseUrl}/`;

    // Valid access token (auto-refresh via refresh_token when expired)
    const accessToken = await getValidKiroAccessToken();
    const profileArn = getKiroProfileArn();

    if (!accessToken || !profileArn) {
      yield createAssistantAPIErrorMessage({
        content:
          'Kiro authentication required: missing access token or profile ARN. Run /login and select Kiro provider.',
        apiError: 'authentication_failed',
      });
      return;
    }

    // codev messages → OpenAI chat wire (reuses the shared converter),
    // then OpenAI chat → CodeWhisperer conversationState.
    const messagesForAPI = normalizeMessagesForAPI(messages, tools);
    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: context.getToolPermissionContext,
          tools,
          agents: context.agents,
          allowedAgentTypes: context.allowedAgentTypes,
          model,
        }),
      ),
    );
    const openaiMessages = agentMessagesToOpenAIChatMessages(
      messagesForAPI,
      undefined, // system prompt is folded into the first user turn
      { supportsImages: true },
    );
    const conversationState = buildConversationState(
      openaiMessages,
      toolSchemas.map(t => ({
        name: (t as unknown as { name?: string }).name ?? '',
        description: (t as unknown as { description?: string }).description,
        input_schema: (t as unknown as { input_schema?: Record<string, unknown> }).input_schema,
      })),
      {
        modelId: model || 'auto',
        systemPrompt: systemPrompt?.join('\n'),
      },
    );

    const body: Record<string, unknown> = {
      conversationState,
      profileArn,
    };

    logForDebugging(
      `[Kiro] GenerateAssistantResponse model=${model} endpoint=${endpoint} tools=${toolSchemas.length}`,
    );

    const response = await requestWithRetry(
      () =>
        httpRequest({
          method: 'POST',
          url: endpoint,
          headers: {
            'Content-Type': 'application/x-amz-json-1.0',
            Accept: 'application/vnd.amazon.eventstream',
            Authorization: `Bearer ${accessToken}`,
            'x-amzn-kiro-profile-arn': profileArn,
            'X-Amz-Target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
            'User-Agent': 'codev',
          },
          body: JSON.stringify(body),
          signal,
        }),
      signal,
      { maxAttempts: 2, baseDelayMs: 500 },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Kiro API failed (${response.status})${text ? `: ${text.slice(0, 800)}` : ''}`,
      );
    }
    if (!response.body) throw new Error('Kiro response missing body');

    const adaptedStream = adaptKiroEventStream(parseEventStreamBody(response.body), model);

    let sawMessageStart = false;
    const newMessages: AssistantMessage[] = [];
    const contentBlocks: Record<number, Record<string, unknown>> = {};

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          sawMessageStart = true;
          partialMessage = event.message;
          ttftMs = Date.now() - start;
          if (event.message.usage) {
            usage = { ...usage, ...(event.message.usage as unknown as typeof usage) };
          }
          break;
        }
        case 'content_block_start': {
          const idx = event.index;
          const cb = event.content_block as unknown as Record<string, unknown>;
          if (cb.type === 'tool_use') contentBlocks[idx] = { ...cb, input: '' };
          else if (cb.type === 'text') contentBlocks[idx] = { ...cb, text: '' };
          else if (cb.type === 'thinking') contentBlocks[idx] = { ...cb, thinking: '' };
          else contentBlocks[idx] = { ...cb };
          break;
        }
        case 'content_block_delta': {
          const idx = event.index;
          const block = contentBlocks[idx];
          if (!block) break;
          const delta = event.delta as {
            type: string;
            text?: string;
            partial_json?: string;
            thinking?: string;
          };
          if (delta.type === 'text_delta') {
            block.text = ((block.text as string | undefined) || '') + (delta.text ?? '');
          } else if (delta.type === 'input_json_delta') {
            block.input = ((block.input as string | undefined) || '') + (delta.partial_json ?? '');
          } else if (delta.type === 'thinking_delta') {
            block.thinking = ((block.thinking as string | undefined) || '') + (delta.thinking ?? '');
          }
          break;
        }
        case 'content_block_stop': {
          const contentBlock = contentBlocks[event.index];
          if (!contentBlock || !partialMessage) break;
          const m: AssistantMessage = {
            message: {
              ...partialMessage,
              content: normalizeContentFromAPI(
                [contentBlock] as unknown as AgentContentBlock[],
                tools,
                context.agentId as AgentId | undefined,
              ),
            },
            requestId: undefined,
            type: 'assistant',
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          } as unknown as AssistantMessage;
          newMessages.push(m);
          yield m;
          break;
        }
        case 'message_delta': {
          const deltaUsage = (event as { usage?: unknown }).usage;
          if (deltaUsage) usage = { ...usage, ...(deltaUsage as Partial<typeof usage>) };
          const stop = (event as { delta?: { stop_reason?: string } }).delta?.stop_reason;
          if (stop != null) stopReason = stop;
          const lastMsg = newMessages.at(-1) as
            | (AssistantMessage & {
                message: { usage?: typeof usage; stop_reason?: string | null };
              })
            | undefined;
          if (lastMsg) {
            lastMsg.message.usage = usage as unknown as typeof lastMsg.message.usage;
            lastMsg.message.stop_reason = stopReason;
          }
          break;
        }
        case 'message_stop':
          break;
        default:
          break;
      }
      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as unknown as StreamEvent;
    }

    if (!sawMessageStart) {
      throw new Error('Kiro returned an empty or non-eventstream response body');
    }

    // Finalize: attach usage to the last message
    const lastMsg = newMessages.at(-1) as
      | (AssistantMessage & { message: { usage?: typeof usage; stop_reason?: string | null } })
      | undefined;
    if (lastMsg) {
      lastMsg.message.usage = usage as unknown as typeof lastMsg.message.usage;
      if (lastMsg.message.stop_reason == null) {
        lastMsg.message.stop_reason = stopReason ?? 'end_turn';
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error instanceof APIUserAbortError ? error : new APIUserAbortError();
    }
    const msg = error instanceof Error ? error.message : String(error);
    logForDebugging(`[Kiro] Request failed: ${msg}`);
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${msg}`,
      apiError: 'api_error',
      error: msg,
    });
  }
}
