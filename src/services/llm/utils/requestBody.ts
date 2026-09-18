/**
 * OpenAI request body utilities — extracted from legacy api/openai/requestBody.ts
 * for use by the native services/llm runtime.
 */

import { isEnvTruthy, isEnvDefinedFalsy } from '../../../utils/envUtils.js'

/**
 * Checks if thinking mode is enabled for the given model.
 *
 * Enabled if:
 * 1. OPENAI_ENABLE_THINKING=1 explicitly set, or
 * 2. Model name contains "deepseek" or "mimo" (auto-detect, case-insensitive)
 *
 * Disabled if:
 * - OPENAI_ENABLE_THINKING=0/false/no/off explicitly set (highest priority)
 *
 * Grok is intentionally excluded: Grok reasoning models reason automatically
 * without needing thinking/enable_thinking request params.
 */
export function isOpenAIThinkingEnabled(model: string): boolean {
  // Explicit disable takes priority
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return false
  // Explicit enable
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return true
  // Auto-detect from model name (DeepSeek and MiMo support thinking mode)
  const modelLower = model.toLowerCase()
  return modelLower.includes('deepseek') || modelLower.includes('mimo')
}

/**
 * Resolves the max output tokens for OpenAI-compatible paths.
 *
 * Priority:
 * 1. maxOutputTokensOverride (programmatic, from query pipeline)
 * 2. OPENAI_MAX_TOKENS env (OpenAI-specific, for local small-context models)
 * 3. CLAUDE_CODE_MAX_OUTPUT_TOKENS env (generic override)
 * 4. upperLimit default value
 */
export function resolveOpenAIMaxTokens(
  upperLimit: number,
  maxOutputTokensOverride?: number,
): number {
  return (
    maxOutputTokensOverride ??
    (process.env.OPENAI_MAX_TOKENS
      ? parseInt(process.env.OPENAI_MAX_TOKENS, 10) || undefined
      : undefined) ??
    (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 10) || undefined
      : undefined) ??
    upperLimit
  )
}

export type OpenAIRequestBody = Record<string, unknown> & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
  prompt_cache_key?: string
}

/**
 * Builds the OpenAI chat.completions request body.
 * Injects thinking parameters in three formats for different endpoints:
 * - Official DeepSeek API:    `thinking: { type: 'enabled' }`
 * - Self-hosted DeepSeek:      `enable_thinking: true` + `chat_template_kwargs: { thinking: true }`
 * - MiMo (Xiaomi):             `chat_template_kwargs: { enable_thinking: true }`
 * HTTP layer passes through unknown keys, no compatibility issues.
 */
export function buildOpenAIRequestBody(params: {
  model: string
  messages: unknown[]
  tools?: unknown[]
  toolChoice?: unknown
  enableThinking: boolean
  maxTokens: number
  temperatureOverride?: number
  /** OpenAI official endpoint session-level prompt-cache routing key. */
  promptCacheKey?: string
}): OpenAIRequestBody {
  const {
    model,
    messages,
    tools,
    toolChoice,
    enableThinking,
    maxTokens,
    temperatureOverride,
    promptCacheKey,
  } = params
  return {
    model,
    messages,
    max_tokens: maxTokens,
    ...(promptCacheKey && { prompt_cache_key: promptCacheKey }),
    ...(tools && tools.length > 0 && {
      tools,
      ...(toolChoice && { tool_choice: toolChoice }),
    }),
    stream: true,
    stream_options: { include_usage: true },
    // DeepSeek / MiMo chain-of-thought output; when enabled temperature etc. ignored by endpoint
    ...(enableThinking && {
      thinking: { type: 'enabled' },
      enable_thinking: true,
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }),
    // Only send temperature when thinking disabled (DeepSeek ignores, but other providers may use)
    ...(!enableThinking &&
      temperatureOverride !== undefined && {
        temperature: temperatureOverride,
      }),
  }
}