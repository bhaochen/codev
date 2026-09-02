/**
 * LLM 调用入口 — 兼容 Facade，薄封装 ModelRuntime。
 * 新代码应直接 import { modelRuntime } from '@/services/llm/runtime'，旧代码 via queryModel 保持兼容。
 * Also re-exports streaming helpers previously in claude.ts.
 */
import { APIUserAbortError } from '@anthropic-ai/sdk/error'
import type { Message, StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { withStreamingVCR } from '../vcr.js'

// Re-export Options from canonical protocol client (previously defined in claude.ts)
export type { Options } from '../llm/clients/anthropicMessages.js'
import type { Options } from '../llm/clients/anthropicMessages.js'

export async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { modelRuntime } = await import('../llm/runtime/index.js')
  yield* modelRuntime.generate({ model: options.model, messages, systemPrompt, tools, signal, options, thinkingConfig })
}

export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    if (signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

// Re-export common API helpers for backwards compatibility (importers should use llm/utils/metadata)
export {
  getAPIMetadata,
  getExtraBodyParams,
  getPromptCachingEnabled,
  getCacheControl,
  buildSystemPromptBlocks,
  addCacheBreakpoints,
  stripExcessMediaItems,
  cleanupStream,
  updateUsage,
  accumulateUsage,
  executeNonStreamingRequest,
  adjustParamsForNonStreaming,
  getMaxOutputTokensForModel,
  MAX_NON_STREAMING_TOKENS,
  configureTaskBudgetParams,
} from '../llm/clients/anthropicMessages.js'
export { verifyApiKey } from '../llm/clients/anthropicMessages.js'
