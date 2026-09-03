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
  adaptOpenAIStreamToAnthropic,
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  type AnthropicMessage,
} from '@ant/model-provider'
import { httpRequest } from '../transport/http.js'
import { parseOpenAIChunksFromSSE } from '../transport/sse.js'
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

    // Responses SSE 与 Chat SSE 结构不同,此处先经通用 SSE framing 再按 Chat 适配;
    // 严格 Responses 规范(response.output_text.delta)需 Responses-specific adapter。
    const adaptedStream = adaptOpenAIStreamToAnthropic(parseOpenAIChunksFromSSE(response.body) as AsyncIterable<never>, model, { includeCacheWriteTokens: false })
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
