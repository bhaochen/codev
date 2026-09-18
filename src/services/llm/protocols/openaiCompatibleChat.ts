/**
 * OpenAI Compatible Chat 协议 — 任意 OpenAI Chat Completions 兼容端点
 * 与 openai-chat 同 wire format (/chat/completions)，但 provider-agnostic。
 * 不含 provider-specific 分支（auth/headers 仅通用 bearer），端点由 Route 传入的任意 baseURL 决定。
 * 保持与 queryOpenAIChat 相同的 AsyncGenerator 输出契约。
 *
 * Native 实现：wire 装配位于 protocols/openaiChatWire.ts，不经
 * @ant/model-provider / Anthropic 消息中间表示。
 */
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'
import type { AgentContentBlock } from '../../../types/agentMessage.js'
import { APIUserAbortError } from '@anthropic-ai/sdk/error'
import { randomUUID } from 'crypto'
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
import { resolveOpenAIMaxTokens } from '../utils/requestBody.js'
import { formatOpenAIPromptCacheKey, updateOpenAIUsage } from '../utils/openaiShared.js'
import { resolveAuth } from '../auth/resolveAuth.js'
import { getOpencodeUserAgent } from '../../api/opencodeUserAgent.js'
import {
  adaptOpenAIChatSSE,
  agentMessagesToOpenAIChatMessages,
  buildOpenAIChatBody,
  chatCompletionsUrlFromBase,
  openAIChatToolChoiceFromLLM,
  openAIChatToolsFromSchemas,
  resolveOpenAIChatThinking,
  type OpenAIChatNormalizedUsage,
  type OpenAIChatStreamEvent,
  type OpenAIChatWireChunk,
} from './openaiChatWire.js'

export { chatCompletionsUrlFromBase as compatibleChatCompletionsUrl } from './openaiChatWire.js'

type OpenAIChatStartMessage = Extract<OpenAIChatStreamEvent, { type: 'message_start' }>['message']

export async function* queryOpenAICompatibleChat(
  route: LLMRoute,
  request: LLMRequest,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal, config, context } = request
  let partialMessage: OpenAIChatStartMessage | null = null
  let ttftMs = 0
  const start = Date.now()
  let usage: OpenAIChatNormalizedUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let stopReason: string | null = null
  let maxTokens = 0
  try {
    const model = route.model
    const endpoint = route.endpoint ?? ''
    if (!endpoint) throw new Error(`openai-compatible-chat route missing endpoint for provider ${route.provider}`)
    const cred = resolveAuth(route.provider)
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)
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
    )
    const openaiMessages = agentMessagesToOpenAIChatMessages(
      messagesForAPI,
      systemPrompt?.join('\n'),
      { supportsImages: true },
    )
    const openaiTools = openAIChatToolsFromSchemas(
      toolSchemas
        .filter(t => {
          const anyT = t as unknown as Record<string, unknown>
          return anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        })
        .map(t => {
          const rec = t as unknown as Record<string, unknown>
          return {
            name: (rec.name as string) ?? '',
            description: rec.description as string | undefined,
            input_schema: rec.input_schema as Record<string, unknown> | undefined,
          }
        }),
    )
    const openaiToolChoice = openAIChatToolChoiceFromLLM(config.toolChoice)

    const { upperLimit } = getModelMaxOutputTokens(model)
    maxTokens = resolveOpenAIMaxTokens(upperLimit, config.maxOutputTokens)
    const promptCacheKey = formatOpenAIPromptCacheKey(getSessionId())
    // reasoning 由 LLMRequestConfig 直构：config.thinking / context.effortValue /
    // 模型与 env 检测都归口到 native thinking 配置，见 resolveOpenAIChatThinking。
    const { enableThinking, reasoning_effort: reasoningEffort } = resolveOpenAIChatThinking(model, config, context)
    logForDebugging(`[OpenAICompatibleChat] provider=${route.provider} model=${model} endpoint=${endpoint} tools=${openaiTools.length} thinking=${enableThinking ? 'on' : 'off'}`)
    const body = buildOpenAIChatBody({
      model,
      messages: openaiMessages,
      tools: openaiTools,
      toolChoice: openaiToolChoice,
      enableThinking,
      reasoningEffort,
      maxTokens,
      temperatureOverride: config.temperature,
      promptCacheKey,
    })
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': route.provider === 'opencode' ? getOpencodeUserAgent() : 'codev',
    }
    if (cred.type === 'bearer') headers.Authorization = `Bearer ${cred.token}`
    else headers.Authorization = 'Bearer public'

    const fetchOverride = context.fetchOverride as unknown as typeof fetch | undefined
    const url = endpoint.includes('/chat/completions') ? endpoint : chatCompletionsUrlFromBase(endpoint)
    const response = await httpRequest(
      { url, method: 'POST', headers, body: JSON.stringify(body), signal },
      fetchOverride,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Upstream ${route.provider} failed (${response.status})${text ? `: ${text.slice(0, 800)}` : ''}`)
    }
    if (!response.body) throw new Error('Upstream response missing body')
    const adaptedStream = adaptOpenAIChatSSE(parseOpenAIChunksFromSSE(response.body) as AsyncIterable<OpenAIChatWireChunk>, model, { includeCacheWriteTokens: false })
    const newMessages: AssistantMessage[] = []
    const contentBlocks: Record<number, Record<string, unknown>> = {}
    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message.usage) usage = { ...usage, ...(event.message.usage as unknown as typeof usage) }
          break
        }
        case 'content_block_start': {
          const idx = event.index
          const cb = event.content_block as unknown as Record<string, unknown>
          if (cb.type === 'tool_use') contentBlocks[idx] = { ...cb, input: '' }
          else if (cb.type === 'text') contentBlocks[idx] = { ...cb, text: '' }
          else if (cb.type === 'thinking') contentBlocks[idx] = { ...cb, thinking: '' }
          else contentBlocks[idx] = { ...cb }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const block = contentBlocks[idx] as Record<string, unknown> | undefined
          if (!block) break
          const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string }
          if (delta.type === 'text_delta') block.text = ((block.text as string | undefined) || '') + delta.text
          else if (delta.type === 'input_json_delta') block.input = ((block.input as string | undefined) || '') + delta.partial_json
          else if (delta.type === 'thinking_delta') block.thinking = ((block.thinking as string | undefined) || '') + delta.thinking
          break
        }
        case 'content_block_stop': {
          const contentBlock = contentBlocks[event.index]
          if (!contentBlock || !partialMessage) break
          const m: AssistantMessage = {
            message: {
              ...partialMessage,
              content: normalizeContentFromAPI([contentBlock] as unknown as AgentContentBlock[], tools, context.agentId as AgentId | undefined),
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
          const lastMsg = newMessages.at(-1) as (AssistantMessage & { message: { usage?: typeof usage; stop_reason?: string | null } }) | undefined
          if (lastMsg) {
            lastMsg.message.usage = usage
            lastMsg.message.stop_reason = stopReason
          }
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(model, usage as unknown as Parameters<typeof calculateUSDCost>[1])
            addToTotalSessionCost(costUSD, usage as unknown as Parameters<typeof addToTotalSessionCost>[1], context.model)
          }
          break
        }
        case 'message_stop': break
      }
      yield { type: 'stream_event', event, ...(event.type === 'message_start' ? { ttftMs } : undefined) } as unknown as StreamEvent
    }
    const lastMsg = newMessages.at(-1) as
      | (AssistantMessage & {
          message: {
            content: unknown[]
            usage?: OpenAIChatNormalizedUsage
            stop_reason?: string | null
          }
        })
      | undefined
    const lastHasToolUse = (lastMsg?.message.content ?? []).some(block => (block as { type?: string }).type === 'tool_use') ?? false
    if (stopReason === null && !lastHasToolUse) {
      if (lastMsg) {
        lastMsg.message.usage = usage
        lastMsg.message.stop_reason = 'max_tokens'
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