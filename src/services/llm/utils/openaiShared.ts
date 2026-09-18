/**
 * OpenAI shared utilities — extracted from legacy api/openai/openaiShared.ts
 * for use by the native services/llm runtime and legacy compatibility.
 */

/**
 * Determines if the configured base URL points to the official OpenAI API.
 *
 * Default URL (empty) implies OpenAI SDK default (api.openai.com). Regional
 * endpoints are subdomains of api.openai.com. Strict check ensures ordinary
 * OpenAI-compatible providers never receive OpenAI-exclusive cache params.
 */
export function isOfficialOpenAIBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL?.trim()) return true

  try {
    const url = new URL(baseURL)
    const isOfficialHost =
      url.hostname === 'api.openai.com' || url.hostname.endsWith('.api.openai.com')
    return url.protocol === 'https:' && isOfficialHost && (url.port === '' || url.port === '443')
  } catch {
    return false
  }
}

/**
 * Constructs a session-stable OpenAI `prompt_cache_key`.
 *
 * OpenAI automatic prefix caching benefits from a sticky routing key so that
 * multi-turn requests land on the same cache node. The key must be stable for
 * the entire session — never derived from message content (changes every turn,
 * routing invalidated).
 *
 * Format: `ccb:<sessionId>`
 */
export function formatOpenAIPromptCacheKey(sessionId: string): string {
  return `ccb:${sessionId}`
}

/**
 * Returns a session-sticky cache key ONLY for the official OpenAI API endpoint;
 * compatible providers must not receive OpenAI-exclusive request params.
 */
export function getOfficialOpenAIPromptCacheKey(
  baseURL: string | undefined,
  sessionId: string,
): string | undefined {
  return isOfficialOpenAIBaseURL(baseURL) ? formatOpenAIPromptCacheKey(sessionId) : undefined
}

/**
 * Merges delta usage into accumulated usage, preserving cached fields' old
 * values when delta carries explicit 0 or undefined.
 */
export function updateOpenAIUsage(
  current: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  },
  delta: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
): typeof current {
  return {
    input_tokens: delta.input_tokens ?? current.input_tokens,
    output_tokens: delta.output_tokens ?? current.output_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens !== undefined && delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : current.cache_creation_input_tokens,
    cache_read_input_tokens:
      delta.cache_read_input_tokens !== undefined && delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : current.cache_read_input_tokens,
  }
}