/**
 * Opencode 原生 query 路径 —— 不经 Anthropic SDK fetch-override。
 *
 * 学习自 ~/Code/Agent/opencode 的原生实现：
 * - packages/llm/src/route/client.ts: LLMClient.stream 编译 LLMRequest → Route → Protocol
 * - packages/opencode/src/session/llm/native-request.ts: ModelMessage → LLMRequest 适配
 * - packages/opencode/src/session/llm/native-runtime.ts: LLMClient.stream + ToolRuntime.dispatch
 *
 * codev 侧简化：复用 queryModelOpenAI 的一等分发形态，直接以 OpenAI Chat
 * Completions 协议访问 https://opencode.ai/zen/v1/chat/completions，不再伪装成
 * Anthropic Messages 再在 fetch 层翻译。LLMRequest/Route 抽象在 codev 侧以
 * convertAnthropicMessagesToOpenAI 的显式转换等价实现，Tool 执行仍由 codev 的
 * ToolRuntime (tool.call) 负责，不引入 FiberSet。
 */
import type {
  BetaMessage,
  BetaStopReason,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  adaptOpenAIStreamToAnthropic,
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  parseOpenAIStream,
  type AnthropicMessage,
  type OpenAIStreamChunk,
} from '@ant/model-provider'
import type { Tools } from '../../../Tool.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getOpenCodeApiKey, getOpenCodeModelName } from '../../../utils/auth.js'
import { getOpencodeBaseUrl } from '../../../utils/model/providers.js'
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
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../../types/message.js'
import type { Options } from '../queryModel.js'
import {
  buildOpenAIRequestBody,
  resolveOpenAIMaxTokens,
} from '../openai/requestBody.js'
import {
  formatOpenAIPromptCacheKey,
  updateOpenAIUsage,
} from '../openai/openaiShared.js'
import { chatCompletionsUrl as openaiChatCompletionsUrl } from '../openai/openaiClient.js'

function isOpencodeConvertibleMessage(
  msg: AssistantMessage | UserMessage,
): msg is AssistantMessage | UserMessage {
  return (
    (msg as { type?: string }).type === 'assistant' ||
    (msg as { type?: string }).type === 'user'
  )
}

function toAnthropicMessage(
  msg: AssistantMessage | UserMessage,
): AnthropicMessage {
  const inner = (
    msg as unknown as {
      message?: { role: 'user' | 'assistant'; content: AnthropicMessage['content'] }
    }
  ).message
  return { role: inner?.role ?? 'user', content: inner?.content ?? '' }
}

function resolveOpencodeModel(fallback: string): string {
  return getOpenCodeModelName() || fallback || 'big-pickle'
}

function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/$/, '')
  if (b.endsWith('/v1')) return `${b}/chat/completions`
  return `${b}/v1/chat/completions`
}

/**
 * Opencode 原生 query：直接走 Chat Completions，不经 Anthropic SDK。
 * 调用形态与 queryModelOpenAI 对齐，产出相同的 StreamEvent|AssistantMessage。
 */
export async function* queryModelOpencode(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  let partialMessage: BetaMessage | null = null
  let ttftMs = 0
  const start = Date.now()
  let usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  let stopReason: string | null = null
  let maxTokens = 0
  let opencodeModel = ''

  try {
    opencodeModel = resolveOpencodeModel(options.model)

    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: opencodeModel,
        }),
      ),
    )

    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
      },
    )

    // 复用与 OpenAI 路径相同的显式转换（非 fetch-override 暗桩）
    const openAIConvertibleMessages = messagesForAPI.filter(
      isOpencodeConvertibleMessage,
    )
    const openaiMessages = convertAnthropicMessagesToOpenAI(
      openAIConvertibleMessages.map(toAnthropicMessage),
      systemPrompt?.join('\n'),
      { supportsImages: true },
    )
    const openaiTools = convertAnthropicToolsToOpenAI(
      standardTools.map(t => ({
        name: (t as { name?: string }).name ?? '',
        description: (t as { description?: string }).description,
        input_schema: (t as { input_schema?: Record<string, unknown> }).input_schema,
      })),
    )
    // Opencode 多为 OpenAI-compatible，tool_choice 固定 auto 即可
    const openaiToolChoice = undefined

    const { upperLimit } = getModelMaxOutputTokens(opencodeModel)
    maxTokens = resolveOpenAIMaxTokens(upperLimit, options.maxOutputTokensOverride)

    const sessionId = getSessionId()
    const promptCacheKey = formatOpenAIPromptCacheKey(sessionId)

    logForDebugging(
      `[OpencodeNative] queryModel: model=${opencodeModel}, messages=${openaiMessages.length}, tools=${openaiTools.length}${promptCacheKey ? `, prompt_cache_key=${promptCacheKey}` : ''}`,
    )

    const adaptedStream = adaptOpenAIStreamToAnthropic(
      await fetchOpencodeStream({
        model: opencodeModel,
        messages: openaiMessages,
        tools: openaiTools,
        toolChoice: openaiToolChoice,
        maxTokens,
        temperatureOverride: options.temperatureOverride,
        promptCacheKey,
        signal,
        fetchOverride: options.fetchOverride as unknown as typeof fetch,
      }),
      opencodeModel,
      { includeCacheWriteTokens: false },
    )

    const newMessages: AssistantMessage[] = []
    const contentBlocks: Record<number, Record<string, unknown>> = {}

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message as unknown as BetaMessage
          ttftMs = Date.now() - start
          if (event.message?.usage) {
            usage = {
              ...usage,
              ...(event.message.usage as unknown as typeof usage),
            }
          }
          break
        }
        case 'content_block_start': {
          const idx = event.index
          const cb = event.content_block as any
          if (cb.type === 'tool_use') {
            contentBlocks[idx] = { ...(cb as any), input: '' }
          } else if (cb.type === 'text') {
            contentBlocks[idx] = { ...(cb as any), text: '' }
          } else if (cb.type === 'thinking') {
            contentBlocks[idx] = { ...(cb as any), thinking: '', signature: '' }
          } else {
            contentBlocks[idx] = { ...(cb as any) }
          }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const block = contentBlocks[idx] as any
          if (!block) break
          const delta = event.delta as any
          if (delta.type === 'text_delta') {
            block.text = ((block.text as string | undefined) || '') + delta.text
          } else if (delta.type === 'input_json_delta') {
            block.input = ((block.input as string | undefined) || '') + delta.partial_json
          } else if (delta.type === 'thinking_delta') {
            block.thinking = ((block.thinking as string | undefined) || '') + delta.thinking
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature
          }
          break
        }
        case 'content_block_stop': {
          const contentBlock = contentBlocks[event.index]
          if (!contentBlock || !partialMessage) {
            logForDebugging(
              `[OpencodeNative] content_block_stop without block/partialMessage (index=${event.index})`,
              { level: 'warn' },
            )
            break
          }
          const m: AssistantMessage = {
            message: {
              ...partialMessage,
              content: normalizeContentFromAPI(
                [contentBlock] as unknown as BetaMessage['content'],
                tools,
                options.agentId as AgentId | undefined,
              ),
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
          if (deltaUsage) {
            usage = updateOpenAIUsage(
              usage,
              deltaUsage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            )
          }
          if (event.delta?.stop_reason != null) {
            stopReason = event.delta.stop_reason
          }
          const lastMsg = newMessages.at(-1) as
            | (AssistantMessage & { message: BetaMessage })
            | undefined
          if (lastMsg) {
            lastMsg.message.usage = usage as BetaUsage
            lastMsg.message.stop_reason = stopReason as BetaStopReason | null
          }
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(
              opencodeModel,
              usage as unknown as Parameters<typeof calculateUSDCost>[1],
            )
            addToTotalSessionCost(
              costUSD,
              usage as unknown as Parameters<typeof addToTotalSessionCost>[1],
              options.model,
            )
          }
          break
        }
        case 'message_stop':
          break
      }
      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as unknown as StreamEvent
    }

    const lastMsg = newMessages.at(-1) as
      | (AssistantMessage & { message: BetaMessage })
      | undefined
    const lastHasToolUse =
      (lastMsg?.message.content ?? []).some(
        block => (block as { type?: string }).type === 'tool_use',
      ) ?? false
    if (stopReason === null && !lastHasToolUse) {
      if (lastMsg) {
        lastMsg.message.usage = usage as BetaUsage
        lastMsg.message.stop_reason = 'max_tokens' as BetaStopReason
      }
      yield createAssistantAPIErrorMessage({
        content: `Opencode response exceeded the ${maxTokens} output token maximum.`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens' as unknown as Parameters<
          typeof createAssistantAPIErrorMessage
        >[0]['error'],
      })
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error instanceof APIUserAbortError ? error : new APIUserAbortError()
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`[OpencodeNative] queryModel error: ${errorMessage}`, {
      level: 'error',
    })
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: 'api_error',
      error,
    })
  }
}

async function fetchOpencodeStream(params: {
  model: string
  messages: Parameters<typeof buildOpenAIRequestBody>[0]['messages']
  tools: Parameters<typeof buildOpenAIRequestBody>[0]['tools']
  toolChoice: unknown
  maxTokens: number
  temperatureOverride?: number
  promptCacheKey?: string
  signal: AbortSignal
  fetchOverride?: typeof fetch
}): Promise<AsyncIterable<OpenAIStreamChunk>> {
  const endpoint = chatCompletionsUrl(getOpencodeBaseUrl())
  const apiKey = getOpenCodeApiKey()
  const body = buildOpenAIRequestBody({
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    enableThinking: false,
    maxTokens: params.maxTokens,
    temperatureOverride: params.temperatureOverride,
    promptCacheKey: params.promptCacheKey,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'codev-opencode-native/1.0',
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-session': `ses_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
    'x-opencode-request': `msg_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers.Authorization = 'Bearer public'
  }

  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: params.signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `Opencode API request failed (${response.status})${text ? `: ${text.slice(0, 800)}` : ''}`,
    )
  }
  if (!response.body) {
    throw new Error('Opencode API response did not include a body')
  }

  return parseOpenAIStream(response.body)
}
