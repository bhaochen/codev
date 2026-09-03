/**
 * OpenAI Responses 协议客户端 — POST /responses
 * Phase 2: 从 openai-chat 真正拆分,不再复用 /chat/completions。
 * 保持与 queryOpenAIChat 相同的 AsyncGenerator 输出契约,但 wire format 独立。
 */
import type { LLMRoute } from '../types.js'
import type { Message } from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { Options } from '../clients/anthropicMessages.js'
import type { StreamEvent, AssistantMessage, SystemAPIErrorMessage, UserMessage } from '../../../types/message.js'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  type AnthropicMessage,
} from '@ant/model-provider'
import { httpRequest } from '../transport/http.js'
import { parseSSERaw, type RawSSEEvent } from '../transport/sse.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import type { AgentId } from '../../../types/ids.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { isAbortError } from '../../../utils/errors.js'
import type { BetaMessage, BetaStopReason, BetaToolUnion, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { buildOpenAIRequestBody, resolveOpenAIMaxTokens } from '../../api/openai/requestBody.js'
import { formatOpenAIPromptCacheKey, updateOpenAIUsage } from '../../api/openai/openaiShared.js'
import { resolveAuth } from '../auth/resolveAuth.js'

function isConvertibleMessage(msg: AssistantMessage | UserMessage): msg is AssistantMessage | UserMessage {
  return (msg as { type?: string }).type === 'assistant' || (msg as { type?: string }).type === 'user'
}
function toAnthropicMessage(msg: AssistantMessage | UserMessage): AnthropicMessage {
  const inner = (msg as unknown as { message?: { role: 'user' | 'assistant'; content: AnthropicMessage['content'] } }).message
  return { role: inner?.role ?? 'user', content: inner?.content ?? '' }
}

export function responsesUrl(base: string): string {
  const b = base.replace(/\/$/, '')
  if (b.endsWith('/v1')) return `${b}/responses`
  return `${b}/v1/responses`
}

/**
 * Responses SSE to Anthropic stream adapter.
 * Input RawSSEEvent (event/data), output Anthropic StreamEvent
 * (message_start / content_block_* / message_delta / message_stop) to reuse downstream.
 * Only text generation is guaranteed; tool/reasoning events are safely ignored.
 */
export async function* adaptOpenAIResponsesSSEToAnthropic(
  rawStream: AsyncIterable<RawSSEEvent>,
  model: string,
): AsyncGenerator<
  | { type: 'message_start'; message: { id: string; type: 'message'; role: 'assistant'; content: []; model: string; stop_reason: null; stop_sequence: null; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: string } | { type: 'thinking'; thinking: string; signature: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string } | { type: 'input_json_delta'; partial_json: string } | { type: 'signature_delta'; signature: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string; stop_sequence: null }; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } }
  | { type: 'message_stop' },
  void
> {
  const newMessageId = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12))
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return `msg_${hex}`
  }
  const messageId = newMessageId()
  let started = false
  let currentIndex = -1
  let textBlockOpen = false
  const openBlocks = new Set<number>()
  let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

  const ensureStarted = function* (): Generator<{ type: 'message_start'; message: { id: string; type: 'message'; role: 'assistant'; content: []; model: string; stop_reason: null; stop_sequence: null; usage: typeof usage } }> {
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } },
      }
    }
  }

  const extractDelta = (parsed: Record<string, unknown>): string | undefined => {
    if (typeof (parsed as { delta?: unknown }).delta === 'string') return (parsed as { delta: string }).delta
    if (typeof (parsed as { text?: unknown }).text === 'string') return (parsed as { text: string }).text
    const d = (parsed as { delta?: unknown }).delta as Record<string, unknown> | undefined
    if (d && typeof d.text === 'string') return d.text
    return undefined
  }

  const extractUsage = (parsed: Record<string, unknown>): typeof usage | undefined => {
    const root = (parsed as { response?: Record<string, unknown> }).response ?? parsed
    const u = (root as { usage?: Record<string, unknown> }).usage ?? (parsed as { usage?: Record<string, unknown> }).usage
    if (!u || typeof u !== 'object') return undefined
    const uu = u as Record<string, unknown>
    const input = (uu.input_tokens as number) ?? (uu.prompt_tokens as number) ?? 0
    const output = (uu.output_tokens as number) ?? (uu.completion_tokens as number) ?? 0
    return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  }

  for await (const raw of rawStream) {
    const evName = raw.event ?? ''
    const dataStr = raw.data.trim()
    if (dataStr === '') continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(dataStr) as Record<string, unknown>
    } catch {
      continue
    }

    // 忽略 response.created / in_progress 等不需要暴露的事件
    if (evName === 'response.created' || evName === 'response.in_progress' || evName === 'response.queued') {
      for (const e of ensureStarted()) yield e as never
      continue
    }

    if (evName === 'response.output_text.delta') {
      const delta = extractDelta(parsed)
      if (delta == null) continue
      for (const e of ensureStarted()) yield e as never
      if (!textBlockOpen) {
        currentIndex++
        textBlockOpen = true
        openBlocks.add(currentIndex)
        yield { type: 'content_block_start', index: currentIndex, content_block: { type: 'text', text: '' } }
      }
      if (delta !== '') {
        yield { type: 'content_block_delta', index: currentIndex, delta: { type: 'text_delta', text: delta } }
      }
      continue
    }

    if (evName === 'response.output_text.done' || evName === 'response.content_part.done') {
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: currentIndex }
        openBlocks.delete(currentIndex)
        textBlockOpen = false
      }
      continue
    }

    if (evName === 'response.completed' || evName === 'response.incomplete' || evName === 'response.failed') {
      // 确保 message_start 已发(空响应情况)
      for (const e of ensureStarted()) yield e as never
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: currentIndex }
        openBlocks.delete(currentIndex)
        textBlockOpen = false
      }
      for (const idx of [...openBlocks]) {
        yield { type: 'content_block_stop', index: idx }
        openBlocks.delete(idx)
      }
      const u = extractUsage(parsed)
      if (u) usage = u
      const status = (parsed as { response?: { status?: string } }).response?.status ?? (parsed as { status?: string }).status
      const stopReason = status === 'incomplete' ? 'max_tokens' : 'end_turn'
      yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { ...usage } }
      yield { type: 'message_stop' }
      return
    }

    // 未支持的事件(如 function_call, reasoning_summary)安全忽略,不 crash
  }

  // 流结束未收到 completed 的兜底收尾
  if (started) {
    for (const idx of [...openBlocks]) {
      yield { type: 'content_block_stop', index: idx }
    }
    if (started) {
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...usage } }
      yield { type: 'message_stop' }
    }
  }
}

/**
 * 将 Chat 风格的 OpenAI messages 映射为 Responses API 的 input。
 * Responses 要求 input 为 item 数组,此处做最小兼容映射:
 * - system messages 合并为 instructions 已在外层处理,此处仅保留 user/assistant
 * - 保持与 chat 相同的消息语义,避免引入额外转换风险
 */
function toResponsesInput(
  openaiMessages: ReturnType<typeof convertAnthropicMessagesToOpenAI>,
  systemPrompt: string | undefined,
): { instructions: string | undefined; input: unknown[] } {
  const instructions = systemPrompt
  // 过滤掉 convertAnthropicMessagesToOpenAI 已把 system 转成的 role:system 消息,
  // Responses 用独立 instructions 字段承载 system
  const input = openaiMessages.filter(m => (m as { role: string }).role !== 'system')
  return { instructions, input }
}

export async function* queryOpenAIResponses(
  route: LLMRoute,
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  let partialMessage: BetaMessage | null = null
  let ttftMs = 0
  const start = Date.now()
  let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let stopReason: string | null = null
  let maxTokens = 0
  try {
    const model = route.model
    const endpoint = route.endpoint ?? ''
    if (!endpoint) throw new Error(`openai-responses route missing endpoint for provider ${route.provider}`)
    const cred = resolveAuth(route.provider)
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)
    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model,
        }),
      ),
    )
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
      },
    )
    const systemText = systemPrompt?.join('\n')
    const openaiMessages = convertAnthropicMessagesToOpenAI(
      messagesForAPI.filter(isConvertibleMessage).map(toAnthropicMessage),
      systemText,
      { supportsImages: true },
    )
    const openaiTools = convertAnthropicToolsToOpenAI(
      standardTools.map(t => ({
        name: (t as { name?: string }).name ?? '',
        description: (t as { description?: string }).description,
        input_schema: (t as { input_schema?: Record<string, unknown> }).input_schema,
      })),
    )

    const { upperLimit } = getModelMaxOutputTokens(model)
    maxTokens = resolveOpenAIMaxTokens(upperLimit, options.maxOutputTokensOverride)
    const promptCacheKey = formatOpenAIPromptCacheKey(getSessionId())
    logForDebugging(`[OpenAIResponses] provider=${route.provider} model=${model} endpoint=${endpoint} tools=${openaiTools.length}`)

    // Responses body: input + instructions + tools + max_output_tokens, 区别于 chat 的 messages/max_tokens
    const { instructions, input } = toResponsesInput(openaiMessages, systemText)
    // 复用 buildOpenAIRequestBody 的通用字段,再做 Responses 字段替换,避免重复实现 thinking/temperature 逻辑
    const chatBody = buildOpenAIRequestBody({
      model,
      messages: openaiMessages,
      tools: openaiTools,
      toolChoice: undefined,
      enableThinking: false,
      maxTokens,
      temperatureOverride: options.temperatureOverride,
      promptCacheKey,
    })
    const body: Record<string, unknown> = {
      model,
      ...(instructions ? { instructions } : {}),
      input,
      ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
      stream: true,
      stream_options: (chatBody as Record<string, unknown>).stream_options,
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      max_output_tokens: maxTokens,
      ...(options.temperatureOverride !== undefined ? { temperature: options.temperatureOverride } : {}),
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'opencode/1.15.6 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    }
    if (cred.type === 'bearer') headers.Authorization = `Bearer ${cred.token}`
    else headers.Authorization = 'Bearer public'

    const fetchOverride = options.fetchOverride as unknown as typeof fetch | undefined
    const url = endpoint.includes('/responses') ? endpoint : responsesUrl(endpoint)
    const response = await httpRequest(
      { url, method: 'POST', headers, body: JSON.stringify(body), signal },
      fetchOverride,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Upstream ${route.provider} failed (${response.status})${text ? `: ${text.slice(0, 800)}` : ''}`)
    }
    if (!response.body) throw new Error('Upstream response missing body')

    const rawStream = parseSSERaw(response.body)
    const adaptedStream = adaptOpenAIResponsesSSEToAnthropic(rawStream, model)
    const newMessages: AssistantMessage[] = []
    const contentBlocks: Record<number, Record<string, unknown>> = {}
    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message as unknown as BetaMessage
          ttftMs = Date.now() - start
          if (event.message?.usage) usage = { ...usage, ...(event.message.usage as unknown as typeof usage) }
          break
        }
        case 'content_block_start': {
          const idx = event.index
          const cb = event.content_block as never
          const c = cb as { type: string }
          if (c.type === 'tool_use') contentBlocks[idx] = { ...(cb as Record<string, unknown>), input: '' }
          else if (c.type === 'text') contentBlocks[idx] = { ...(cb as Record<string, unknown>), text: '' }
          else if (c.type === 'thinking') contentBlocks[idx] = { ...(cb as Record<string, unknown>), thinking: '', signature: '' }
          else contentBlocks[idx] = { ...(cb as Record<string, unknown>) }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const block = contentBlocks[idx] as Record<string, unknown> | undefined
          if (!block) break
          const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
          if (delta.type === 'text_delta') block.text = ((block.text as string | undefined) || '') + (delta.text ?? '')
          else if (delta.type === 'input_json_delta') block.input = ((block.input as string | undefined) || '') + (delta.partial_json ?? '')
          else if (delta.type === 'thinking_delta') block.thinking = ((block.thinking as string | undefined) || '') + (delta.thinking ?? '')
          else if (delta.type === 'signature_delta') block.signature = delta.signature
          break
        }
        case 'content_block_stop': {
          const contentBlock = contentBlocks[event.index]
          if (!contentBlock || !partialMessage) break
          const m: AssistantMessage = {
            message: {
              ...partialMessage,
              content: normalizeContentFromAPI([contentBlock] as unknown as BetaMessage['content'], tools, options.agentId as AgentId | undefined),
            },
            requestId: undefined,
            type: 'assistant',
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          } as unknown as AssistantMessage
          newMessages.push(m)
          yield m
          break
        }
        case 'message_delta': {
          const deltaUsage = event.usage
          if (deltaUsage) usage = updateOpenAIUsage(usage, deltaUsage as unknown as Parameters<typeof updateOpenAIUsage>[1])
          if (event.delta?.stop_reason != null) stopReason = event.delta.stop_reason
          const lastMsg = newMessages.at(-1) as (AssistantMessage & { message: BetaMessage }) | undefined
          if (lastMsg) {
            lastMsg.message.usage = usage as BetaUsage
            lastMsg.message.stop_reason = stopReason as BetaStopReason | null
          }
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(model, usage as unknown as Parameters<typeof calculateUSDCost>[1])
            addToTotalSessionCost(costUSD, usage as unknown as Parameters<typeof addToTotalSessionCost>[1], options.model)
          }
          break
        }
        case 'message_stop': break
      }
      yield { type: 'stream_event', event, ...(event.type === 'message_start' ? { ttftMs } : undefined) } as unknown as StreamEvent
    }
    const lastMsg = newMessages.at(-1) as (AssistantMessage & { message: BetaMessage }) | undefined
    const lastHasToolUse = (lastMsg?.message.content ?? []).some(block => (block as { type?: string }).type === 'tool_use') ?? false
    if (stopReason === null && !lastHasToolUse) {
      if (lastMsg) {
        lastMsg.message.usage = usage as BetaUsage
        lastMsg.message.stop_reason = 'max_tokens' as BetaStopReason
      }
      yield createAssistantAPIErrorMessage({
        content: `Upstream ${route.provider} response exceeded ${maxTokens} tokens`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens' as never,
      })
    }
  } catch (error) {
    if (isAbortError(error)) throw error instanceof APIUserAbortError ? error : new APIUserAbortError()
    const msg = error instanceof Error ? error.message : String(error)
    yield createAssistantAPIErrorMessage({ content: `API Error: ${msg}`, apiError: 'api_error', error })
  }
}
