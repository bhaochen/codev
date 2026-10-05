import { getSettingsForSource } from '../settings/settings.js'

export type FallbackProvider =
  | 'firstParty'
  | 'anthropic'
  | 'openai'
  | 'opencode'
  | 'nvidia'

export type FallbackTarget = {
  provider: FallbackProvider
  model: string
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export function getConfiguredFallbackChain(): FallbackTarget[] {
  const settings = getSettingsForSource('userSettings')
  return settings?.fallbackEnabled === false ? [] : (settings?.fallbackChain ?? [])
}

export function isFallbackEligibleError(error: unknown, content?: unknown): boolean {
  if (
    error === 'authentication_failed' ||
    error === 'rate_limit' ||
    error === 'billing_error'
  ) {
    return true
  }
  const status = findStatus(error) ?? findStatus(content)
  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  ) {
    return true
  }
  // 上游服务端报 400/404 但语义是"端点/模型不可用"时同样应触发 fallback
  //（某些 provider，如 opencode Console，把上游下线报成 400 server_error）。
  if (status === 400 || status === 404) {
    const haystack = `${stringifyForMatch(error)}\n${typeof content === 'string' ? content : stringifyForMatch(content)}`
    if (
      /endpoint is unavailable|not available|unavailable|not found|no such model|model.*(not available|invalid)|does not exist/i.test(
        haystack,
      )
    ) {
      return true
    }
  }
  return false
}

function stringifyForMatch(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function findStatus(value: unknown, visited = new Set<unknown>()): number | undefined {
  if (typeof value === 'string') {
    const match =
      value.match(/\b(?:status\s*[:=]?\s*|upstream[^()]*\(|HTTP(?: error)?\s*)(\d{3})\b/i) ??
      value.match(/\b([45]\d{2})\b/)
    return match ? Number(match[1]) : undefined
  }
  if (typeof value !== 'object' || value === null || visited.has(value)) return undefined
  visited.add(value)
  const record = value as Record<string, unknown>
  for (const candidate of [record.status, record.statusCode, record.response, record.cause, record.message]) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) return candidate
    const status = findStatus(candidate, visited)
    if (status !== undefined) return status
  }
  return undefined
}
