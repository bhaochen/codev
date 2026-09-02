// LLM API metadata / cache helpers — canonical re-exports from anthropicMessages protocol client
// New home for helpers previously in src/services/api/claude.ts

export {
  getAPIMetadata,
  getExtraBodyParams,
  getPromptCachingEnabled,
  getCacheControl,
  configureTaskBudgetParams,
  buildSystemPromptBlocks,
  addCacheBreakpoints,
  userMessageToMessageParam,
  assistantMessageToMessageParam,
  stripExcessMediaItems,
  cleanupStream,
  executeNonStreamingRequest,
  adjustParamsForNonStreaming,
  getMaxOutputTokensForModel,
  MAX_NON_STREAMING_TOKENS,
} from '../clients/anthropicMessages.js'
export type { Options } from '../clients/anthropicMessages.js'
