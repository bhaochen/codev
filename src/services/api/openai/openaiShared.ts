/**
 * OpenAI 兼容路径的共享工具（纯净模块，无 bootstrap/state 依赖，
 * 便于纯请求体单元测试与隔离 mock）。
 */

/**
 * 判断配置的 base URL 是否直指 OpenAI 官方 API。
 *
 * 缺省 URL 表示 OpenAI SDK 默认值（api.openai.com）。区域端点均为
 * api.openai.com 的子域。保持严格，让普通 OpenAI 兼容 provider
 * 绝不收到 OpenAI 专属的 cache 参数。
 */
export function isOfficialOpenAIBaseURL(
  baseURL: string | undefined,
): boolean {
  if (!baseURL?.trim()) return true

  try {
    const url = new URL(baseURL)
    const isOfficialHost =
      url.hostname === 'api.openai.com' ||
      url.hostname.endsWith('.api.openai.com')
    return (
      url.protocol === 'https:' &&
      isOfficialHost &&
      (url.port === '' || url.port === '443')
    )
  } catch {
    return false
  }
}

/**
 * 构造会话级稳定的 OpenAI `prompt_cache_key`。
 *
 * OpenAI 自动前缀缓存受益于粘性路由键，让多轮请求落到同一缓存节点。
 * 键必须对整个会话稳定 —— 绝不从消息体推导（每轮都变，路由失效）。
 *
 * 格式：`ccb:<sessionId>`
 */
export function formatOpenAIPromptCacheKey(sessionId: string): string {
  return `ccb:${sessionId}`
}

/**
 * 仅为 OpenAI 官方 API 端点返回会话粘性 cache key；
 * 兼容 provider 不得接收 OpenAI 专属请求参数。
 */
export function getOfficialOpenAIPromptCacheKey(
  baseURL: string | undefined,
  sessionId: string,
): string | undefined {
  return isOfficialOpenAIBaseURL(baseURL)
    ? formatOpenAIPromptCacheKey(sessionId)
    : undefined
}

/**
 * 将 delta usage 合并进累计 usage，保留缓存相关字段的旧值
 * （当 delta 携带显式 0 或 undefined）。
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
      delta.cache_creation_input_tokens !== undefined &&
      delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : current.cache_creation_input_tokens,
    cache_read_input_tokens:
      delta.cache_read_input_tokens !== undefined &&
      delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : current.cache_read_input_tokens,
  }
}