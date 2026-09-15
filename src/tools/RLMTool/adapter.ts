/**
 * LLM adapter — bridges the engine's ChatMsg[] format to codev's queryModelWithoutStreaming.
 *
 * pi-rlm uses modelComplete(history, {model, registry, maxTokens, temperature, ...}).
 * codev uses queryModelWithoutStreaming({messages, systemPrompt, thinkingConfig, tools, signal, options}).
 *
 * This adapter is the only file that imports codev service internals.
 */

import type { Message } from '../../types/message.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryModelWithoutStreaming } from '../../services/api/queryModel.js'
import type { Options } from '../../services/api/queryModel.js'
import { createUserMessage } from '../../utils/messages.js'

/** Engine-compatible chat message — same as pi-rlm ChatMsg. */
export interface ChatMsg {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** Minimal usage shape matching pi-rlm Usage. */
export interface Usage {
  readonly input: number
  readonly output: number
  readonly totalTokens: number
}

/** What the engine receives back from a completion. */
export interface CompleteResult {
  readonly text: string
  readonly usage: Usage
}

/** Signature of a model completion in engine format — testable override for the engine. */
export type CompleteFn = (
  history: readonly ChatMsg[],
  sampling?: Sampling,
) => Promise<CompleteResult>

/** Sampling knobs forwarded to codev options. */
export interface Sampling {
  readonly maxTokens?: number
  readonly temperature?: number
  /** Maps to ThinkingConfig; undefined = disabled. */
  readonly reasoning?: string
}

/** Dependencies the adapter needs to call codev's API. Provided by the controller. */
export interface AdapterDeps {
  /** Current model name (from codev settings / ToolUseContext). */
  readonly model: string
  /** AbortSignal for the whole run. */
  readonly signal?: AbortSignal
  /** Minimal Options fields required by queryModelWithoutStreaming. */
  readonly getToolPermissionContext: Options['getToolPermissionContext']
  readonly querySource: Options['querySource']
  /** Hard upper bound for one provider request, including root and sub-LLM calls. */
  readonly requestTimeoutMs?: number
}

/** Map engine reasoning level → codev ThinkingConfig. */
function toThinkingConfig(reasoning?: string): ThinkingConfig {
  if (!reasoning || reasoning === 'off') return { type: 'disabled' as const }
  return { type: 'enabled' as const, budgetTokens: 16_384 }
}

/**
 * Extract plain text from a raw assistant response.
 *
 * The response's TS type (`AssistantMessage`) declares a flat `content`, but the streaming
 * pipeline hands out SDK-shape objects with a nested `.message` (same divergence the rest of
 * the codebase papers over with casts). Access the runtime shape defensively.
 */
function extractTextFromRaw(raw: unknown): string {
  const msg = (raw as { message?: unknown })?.message ?? raw
  const content = (msg as { content?: unknown })?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('')
}

/** Read usage from the raw response (SDK shape: `message.usage.input_tokens/output_tokens`). */
function usageFromRaw(raw: unknown): Usage {
  const msg = (raw as { message?: unknown })?.message ?? raw
  const u = (msg as { usage?: Record<string, number> })?.usage
  const input = u?.input_tokens ?? 0
  const output = u?.output_tokens ?? 0
  return { input, output, totalTokens: input + output }
}

/**
 * Perform a single non-streaming LLM completion, bridging engine format to codev format.
 *
 * System messages are separated from the history and passed as the systemPrompt parameter.
 * Only user and assistant messages reach the messages array.
 */
export async function adapterComplete(
  messages: readonly ChatMsg[],
  sampling: Sampling | undefined,
  deps: AdapterDeps,
): Promise<CompleteResult> {
  const systemParts: string[] = []
  const apiMessages: Message[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content)
    } else if (m.role === 'user') {
      apiMessages.push(createUserMessage({ content: m.content }))
    } else {
      // assistant — synthesize as a normal assistant message
      apiMessages.push({
        role: 'assistant',
        content: [{ type: 'text' as const, text: m.content }],
        uuid: `rlm-assistant-${Math.random().toString(36).slice(2)}`,
        timestamp: Date.now(),
      })
    }
  }

  const systemPrompt = asSystemPrompt(
    systemParts.length > 0 ? [systemParts.join('\n\n')] : [],
  )

  const thinkingConfig = toThinkingConfig(sampling?.reasoning)

  const requestTimeoutMs = deps.requestTimeoutMs ?? 2 * 60_000
  const timeout = AbortSignal.timeout(requestTimeoutMs)
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout

  const response = await queryModelWithoutStreaming({
    messages: apiMessages,
    systemPrompt,
    thinkingConfig,
    tools: [],
    signal,
    options: {
      getToolPermissionContext: deps.getToolPermissionContext,
      model: deps.model,
      toolChoice: undefined,
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      agents: [],
      querySource: deps.querySource,
      mcpTools: [],
      skipCacheWrite: true,
      ...(sampling?.maxTokens !== undefined ? { maxOutputTokensOverride: sampling.maxTokens } : {}),
      ...(sampling?.temperature !== undefined ? { temperatureOverride: sampling.temperature } : {}),
    },
  })

  const text = extractTextFromRaw(response)
  return { text, usage: usageFromRaw(response) }
}
