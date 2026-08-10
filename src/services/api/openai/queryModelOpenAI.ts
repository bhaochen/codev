/**
 * OpenAI 一等 query 路径（codev 适配版）。
 *
 * 对比桥接器（fetch-override，见 openaiClient.ts）：本模块是 query 管线的一等
 * 公民 —— 直接在 queryModel 分发点被调用，消费与 Anthropic 路径相同的
 * Message[]/SystemPrompt/Tools/Options，产出相同的
 * StreamEvent | AssistantMessage | SystemAPIErrorMessage。
 *
 * 两条后端：
 * - ChatGPT 订阅（OPENAI_AUTH_MODE=chatgpt）：走 Codex Responses 后端
 *   （chatgpt.com/backend-api/codex/responses），见 responsesAdapter.ts。
 * - API key / OpenAI 兼容端点：走 Chat Completions（手写 fetch，无 openai SDK
 *   依赖），见 openaiClient.ts 的 chatCompletionsUrl。
 *
 * 事件产出形状与 codev Anthropic 路径（claude.ts queryModel）逐一对齐：
 * - content_block_stop 时按块 yield 一条嵌套 AssistantMessage
 * - message_delta 时回写 usage / stop_reason 到最后一条消息并发成本统计
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
  anthropicToolChoiceToOpenAI,
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  parseOpenAIStream,
  resolveOpenAIModel,
  type AnthropicMessage,
  type OpenAIStreamChunk,
} from '@ant/model-provider'
import type { Tools } from '../../../Tool.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getOpenAIApiKey } from '../../../utils/auth.js'
import { getOpenAIBaseUrl } from '../../../utils/model/providers.js'
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import type {
  AgentId,
} from '../../../types/ids.js'
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
import type { Options } from '../claude.js'
import {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
} from './requestBody.js'
import {
  formatOpenAIPromptCacheKey,
  getOfficialOpenAIPromptCacheKey,
  updateOpenAIUsage,
} from './openaiShared.js'
import { chatCompletionsUrl } from './openaiClient.js'
import { isChatGPTAuthEnabled } from './chatgptAuth.js'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createChatGPTResponsesStream,
  type ResponsesReasoningEffort,
} from './responsesAdapter.js'

const OPENAI_MAX_TOKENS_HINT =
  'Set OPENAI_MAX_TOKENS or CLAUDE_CODE_MAX_OUTPUT_TOKENS to override.'

function isOpenAIConvertibleMessage(
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
  // codev 运行时消息是嵌套 shape：{ type, message: { role, content } }。
  const inner = (
    msg as unknown as {
      message?: { role: 'user' | 'assistant'; content: AnthropicMessage['content'] }
    }
  ).message
  return { role: inner?.role ?? 'user', content: inner?.content ?? '' }
}

function convertToResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  if (effortValue === 'low') return 'low'
  if (effortValue === 'medium') return 'medium'
  if (effortValue === 'high') return 'high'
  if (effortValue === 'xhigh') return 'xhigh'
  if (effortValue === 'max') return 'max'
  if (typeof effortValue === 'number') return 'high'
  return undefined
}

function getChatGPTResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase()
  if (envOverride === 'auto' || envOverride === 'unset') return undefined
  return (
    convertToResponsesReasoningEffort(envOverride) ??
    convertToResponsesReasoningEffort(effortValue) ??
    'medium'
  )
}

/**
 * OpenAI-compatible query path。调用方式与 Anthropic 路径的 queryModel 一致；
 * 在 claude.ts 的 queryModel 顶部按 provider 分发。
 */
export async function* queryModelOpenAI(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
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
  let openaiModel = ''

  try {
    // 1. Resolve model name
    openaiModel = resolveOpenAIModel(options.model)

    // 2. Normalize messages using shared preprocessing
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    // 3. Build tool schemas（同 Anthropic 路径的 toolToAPISchema）
    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
        }),
      ),
    )

    // 4. Filter out non-standard tools（服务端工具没有 OpenAI 等价物）
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' &&
          anyT.type !== 'computer_20250124'
        )
      },
    )

    // 5. Convert messages and tools to OpenAI format
    const enableThinking = isOpenAIThinkingEnabled(openaiModel)
    const openAIConvertibleMessages = messagesForAPI.filter(
      isOpenAIConvertibleMessage,
    )
    const openaiMessages = convertAnthropicMessagesToOpenAI(
      openAIConvertibleMessages.map(toAnthropicMessage),
      systemPrompt?.join('\n'),
      { enableThinking },
    )
    const openaiTools = convertAnthropicToolsToOpenAI(
      standardTools.map(t => ({
        name: (t as { name?: string }).name ?? '',
        description: (t as { description?: string }).description,
        input_schema: (t as { input_schema?: Record<string, unknown> })
          .input_schema,
      })),
    )
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)
    const reasoningEffort = getChatGPTResponsesReasoningEffort(
      options.effortValue,
    )

    // 6. Compute max_tokens —— 大部分 OpenAI 兼容端点必需。
    //    优先级同 claude-code：maxOutputTokensOverride > OPENAI_MAX_TOKENS >
    //    CLAUDE_CODE_MAX_OUTPUT_TOKENS > upperLimit（64000）。
    const { upperLimit } = getModelMaxOutputTokens(openaiModel)
    maxTokens = resolveOpenAIMaxTokens(
      upperLimit,
      options.maxOutputTokensOverride,
    )

    const useChatGPTResponses = isChatGPTAuthEnabled()
    const sessionId = getSessionId()
    const sessionPromptCacheKey = formatOpenAIPromptCacheKey(sessionId)
    const promptCacheKey = useChatGPTResponses
      ? sessionPromptCacheKey
      : getOfficialOpenAIPromptCacheKey(process.env.OPENAI_BASE_URL, sessionId)
    const useOfficialOpenAICache = promptCacheKey !== undefined

    logForDebugging(
      `[OpenAI] queryModel: model=${openaiModel}, messages=${openaiMessages.length}, tools=${openaiTools.length}, thinking=${enableThinking}${promptCacheKey ? `, prompt_cache_key=${promptCacheKey}` : ''}`,
    )

    // 7. Call OpenAI — ChatGPT 订阅走 Responses 后端；API key / 兼容端点走
    //    Chat Completions（手写 fetch，避免 openai npm SDK 依赖）。
    const adaptedStream = useChatGPTResponses
      ? adaptResponsesStreamToAnthropic(
          await createChatGPTResponsesStream({
            request: buildResponsesRequest({
              model: openaiModel,
              messages: openaiMessages,
              tools: openaiTools,
              toolChoice: openaiToolChoice,
              reasoningEffort,
              promptCacheKey: sessionPromptCacheKey,
            }),
            signal,
            fetchOverride: options.fetchOverride as unknown as typeof fetch,
          }),
          openaiModel,
        )
      : adaptOpenAIStreamToAnthropic(
          await fetchChatCompletionsStream({
            model: openaiModel,
            messages: openaiMessages,
            tools: openaiTools,
            toolChoice: openaiToolChoice,
            enableThinking,
            maxTokens,
            temperatureOverride: options.temperatureOverride,
            promptCacheKey,
            signal,
            fetchOverride: options.fetchOverride as unknown as typeof fetch,
          }),
          openaiModel,
          { includeCacheWriteTokens: useOfficialOpenAICache },
        )

    // 8. Process Anthropic-format event stream into AssistantMessage + StreamEvent，
    //    与 codev Anthropic 路径（claude.ts:1760-2304）的形状完全一致：
    //    - content_block_stop 时按块 yield 一条嵌套 AssistantMessage
    //    - message_delta 时回写 usage / stop_reason 到最后一条消息（直接 mutation，
    //      transcript 写队列持有引用），并发成本统计
    //    - 每个事件都转发为 stream_event 供实时显示
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
          const cb = event.content_block
          if (cb.type === 'tool_use') {
            contentBlocks[idx] = { ...cb, input: '' }
          } else if (cb.type === 'text') {
            contentBlocks[idx] = { ...cb, text: '' }
          } else if (cb.type === 'thinking') {
            contentBlocks[idx] = { ...cb, thinking: '', signature: '' }
          } else {
            contentBlocks[idx] = { ...cb }
          }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const block = contentBlocks[idx]
          if (!block) break
          const delta = event.delta
          if (delta.type === 'text_delta') {
            block.text =
              ((block.text as string | undefined) || '') + delta.text
          } else if (delta.type === 'input_json_delta') {
            block.input =
              ((block.input as string | undefined) || '') + delta.partial_json
          } else if (delta.type === 'thinking_delta') {
            block.thinking =
              ((block.thinking as string | undefined) || '') + delta.thinking
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature
          }
          break
        }
        case 'content_block_stop': {
          const contentBlock = contentBlocks[event.index]
          if (!contentBlock || !partialMessage) {
            logForDebugging(
              `[OpenAI] content_block_stop without block/partialMessage (index=${event.index})`,
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

          // 回写 usage / stop_reason 到最后一条消息（direct mutation，同原生路径）
          const lastMsg = newMessages.at(-1) as
            | (AssistantMessage & { message: BetaMessage })
            | undefined
          if (lastMsg) {
            lastMsg.message.usage = usage as BetaUsage
            lastMsg.message.stop_reason = stopReason as BetaStopReason | null
          }

          // 成本统计
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(
              openaiModel,
              usage as unknown as Parameters<typeof calculateUSDCost>[1],
            )
            addToTotalSessionCost(
              costUSD,
              usage as unknown as Parameters<typeof addToTotalSessionCost>[1],
              options.model,
            )
          }

          if (stopReason === 'max_tokens') {
            yield createAssistantAPIErrorMessage({
              content: `OpenAI response exceeded the ${maxTokens} output token maximum. ${OPENAI_MAX_TOKENS_HINT}`,
              apiError: 'max_output_tokens',
              error: 'max_output_tokens' as unknown as Parameters<
                typeof createAssistantAPIErrorMessage
              >[0]['error'],
            })
          }
          break
        }
        case 'message_stop':
          break
      }

      // 转发给 UI 层（同 Anthropic 路径）
      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as unknown as StreamEvent
    }

    // 9. Safety: 若流提前结束（无 message_delta/message_stop），把最后一条消息
    //    的 usage / stop_reason 补写，保证 cost 统计做账
    const lastMsg = newMessages.at(-1) as
      | (AssistantMessage & { message: BetaMessage })
      | undefined
    if (lastMsg && stopReason === null && usage.output_tokens > 0) {
      lastMsg.message.usage = usage as BetaUsage
      lastMsg.message.stop_reason = 'end_turn' as BetaStopReason
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error instanceof APIUserAbortError
        ? error
        : new APIUserAbortError()
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`[OpenAI] queryModel error: ${errorMessage}`, {
      level: 'error',
    })
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: 'api_error',
      error,
    })
  }
}

/** 向 Chat Completions 端点发起流式请求（无需 openai npm SDK）。 */
async function fetchChatCompletionsStream(params: {
  model: string
  messages: Parameters<typeof buildOpenAIRequestBody>[0]['messages']
  tools: Parameters<typeof buildOpenAIRequestBody>[0]['tools']
  toolChoice: unknown
  enableThinking: boolean
  maxTokens: number
  temperatureOverride?: number
  promptCacheKey?: string
  signal: AbortSignal
  fetchOverride?: typeof fetch
}): Promise<AsyncIterable<OpenAIStreamChunk>> {
  const endpoint = chatCompletionsUrl(getOpenAIBaseUrl())
  const apiKey = getOpenAIApiKey()
  const body = buildOpenAIRequestBody({
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    enableThinking: params.enableThinking,
    maxTokens: params.maxTokens,
    temperatureOverride: params.temperatureOverride,
    promptCacheKey: params.promptCacheKey,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'claude-code/2.1.88',
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
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
      `OpenAI compatible API request failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ''}`,
    )
  }
  if (!response.body) {
    throw new Error('OpenAI compatible API response did not include a body')
  }

  return parseOpenAIStream(response.body)
}