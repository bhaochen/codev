/**
 * OpenAI 兼容层 —— src/services/api/openai/
 *
 * 与 claude-code 的独立 openai/ 目录对齐：
 * - openaiClient.ts  真直连 fetch override（OPENAI_API_KEY/OPENAI_BASE_URL）
 * - requestBody.ts   thinking 模式检测 + 请求体构造（多格式 thinking 参数）
 * - openaiShared.ts  官方端点判定 / prompt cache key / usage 合并
 * - models.ts        模型列表获取（telegram /connect 用）
 *
 * 转换管线（消息/工具/流/usage/错误）由共享包 @ant/model-provider 提供。
 */
export {
  createOpenAIFetchOverride,
  chatCompletionsUrl,
} from './openaiClient.js'
export {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
  type OpenAIRequestBody,
} from './requestBody.js'
export {
  isOfficialOpenAIBaseURL,
  formatOpenAIPromptCacheKey,
  getOfficialOpenAIPromptCacheKey,
  updateOpenAIUsage,
} from './openaiShared.js'
export {
  fetchOpenAICompatibleModelIds,
  fetchAnthropicCompatibleModelIds,
} from './models.js'