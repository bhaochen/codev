/**
 * @ant/model-provider
 *
 * 模型 provider 抽象层（codev 版）：
 * 拥有 OpenAI 兼容协议的完整转换管线，供 src/services/api/openai、
 * opencodeClient、nvidiaClient 共享：
 *
 * - 消息转换（Anthropic → OpenAI，thinking 保留往返）
 * - 工具转换（含 const→enum schema 清洗，兼容 Ollama/vLLM/DeepSeek）
 * - 非流式响应转换
 * - 流式适配（reasoning_content → thinking 块 + usage 归一化）+ SSE 传输
 * - usage / token 估算
 * - 错误响应包装
 * - OpenAI 模型映射（resolveOpenAIModel）
 */

// 类型
export type {
  OpenAIMessage,
  OpenAITool,
  OpenAIStreamChunk,
  AnthropicMessage,
  AnthropicContentBlock,
} from './types.js'

// 消息转换
export {
  convertAnthropicMessagesToOpenAI,
  convertInternalUserMessage,
  convertInternalAssistantMessage,
  type ConvertMessagesOptions,
} from './shared/openaiConvertMessages.js'

// 工具转换
export {
  convertAnthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  type AnthropicToolSchema,
} from './shared/openaiConvertTools.js'

// 非流式响应转换
export {
  convertOpenAIResponseToAnthropic,
  type OpenAIResponseShape,
} from './shared/openaiConvertResponse.js'

// 流式适配 + SSE 传输
export {
  adaptOpenAIStreamToAnthropic,
  type AnthropicStreamEvent,
} from './shared/openaiStreamAdapter.js'
export {
  parseOpenAIStream,
  serializeAnthropicStreamEvent,
  convertOpenAIStreamToAnthropic,
} from './shared/openaiSSE.js'

// usage / token 估算
export {
  normalizeOpenAIUsage,
  estimateTokensForAnthropicBody,
  type AnthropicUsage,
} from './shared/openaiUsage.js'

// 错误响应包装
export { createAnthropicErrorResponse } from './shared/openaiErrorResponse.js'

// OpenAi 模型映射
export {
  resolveOpenAIModel,
  openAIModelSupportsImages,
  resolveOpenAIModelSupportsImages,
  resetModelsDevCache,
} from './providers/openai/modelMapping.js'