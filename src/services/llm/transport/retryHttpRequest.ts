import { sleep } from '../../../utils/sleep.js'

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
])
const MAX_RETRY_DELAY_MS = 10_000

export type RetryHttpRequestOptions = {
  maxAttempts?: number
  baseDelayMs?: number
}

function getRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined

  const seconds = Number(value)
  const delayMs = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now()
  if (!Number.isFinite(delayMs) || delayMs < 0) return undefined
  return Math.min(delayMs, MAX_RETRY_DELAY_MS)
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = (error as { cause?: unknown }).cause
  const code =
    (error as NodeJS.ErrnoException).code ??
    (cause && typeof cause === 'object'
      ? (cause as NodeJS.ErrnoException).code
      : undefined)
  if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) return true
  // A fetch failure surfaces as TypeError("fetch failed") with the real errno
  // in `cause`. Only retry that shape — a bare TypeError is usually a
  // programmer error (bad URL/init) that retrying cannot fix.
  if (error instanceof TypeError) {
    return cause instanceof Error || /fetch failed|network/i.test(error.message)
  }
  return false
}

/**
 * Retry only before a response stream is handed to the caller. This makes a
 * retry safe: no partial assistant output or tool calls can be duplicated.
 */
export async function requestWithRetry(
  request: () => Promise<Response>,
  signal?: AbortSignal,
  options: RetryHttpRequestOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 300

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    let response: Response
    try {
      response = await request()
    } catch (error) {
      if (
        signal?.aborted ||
        attempt === maxAttempts ||
        !isRetryableNetworkError(error)
      ) {
        throw error
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1), signal, {
        abortError: () => new DOMException('Aborted', 'AbortError'),
      })
      continue
    }

    if (
      attempt === maxAttempts ||
      !RETRYABLE_STATUS_CODES.has(response.status)
    ) {
      return response
    }

    const delayMs =
      getRetryAfterMs(response) ?? baseDelayMs * 2 ** (attempt - 1)
    await response.body?.cancel()
    await sleep(delayMs, signal, {
      abortError: () => new DOMException('Aborted', 'AbortError'),
    })
  }

  throw new Error('HTTP request retry loop exited unexpectedly')
}
