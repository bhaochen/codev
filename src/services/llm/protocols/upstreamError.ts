/**
 * Upstream failures carried inside an OpenAI-compatible SSE stream.
 *
 * OpenRouter (and some gateways) report an upstream provider failure as a
 * normal data frame — `{"error": {...}}`, or `finish_reason: "error"` /
 * `native_finish_reason: "error"` with no content. Left alone, such a frame
 * either yields nothing and the turn ends silently, or is mapped to
 * `end_turn`, so the user sees an empty answer instead of the reason.
 *
 * This module turns those frames into a throw, so the client's error path
 * surfaces the provider, code and message.
 */

export type UpstreamFailure = {
  message: string
  /** Rate limit / no-capacity: the same request may succeed after a wait. */
  capacity: boolean
  retryAfterMs?: number
  provider?: string
  code?: string | number
  status?: number
}

export class UpstreamStreamError extends Error {
  readonly failure: UpstreamFailure

  constructor(failure: UpstreamFailure) {
    super(failure.message)
    this.name = 'UpstreamStreamError'
    this.failure = failure
  }
}

const CAPACITY_PATTERN =
  /\b429\b|rate.?limit|resource[_ ]exhausted|quota|no capacity|capacity|overloaded|temporarily unavailable|try again later/i

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined
}

/**
 * Extract an upstream failure from one streamed chunk, or undefined when the
 * chunk is ordinary content.
 */
export function upstreamFailureFromChunk(
  chunk: Record<string, unknown>,
): UpstreamFailure | undefined {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : []
  const choice = asRecord(choices[0])
  const finish =
    stringField(choice?.finish_reason) ?? stringField(choice?.native_finish_reason)
  const errorRecord = asRecord(chunk.error) ?? asRecord(choice?.error)
  const errorText = stringField(chunk.error) ?? stringField(choice?.error)
  if (!errorRecord && !errorText && finish !== 'error') return undefined

  const metadata = asRecord(errorRecord?.metadata)
  const provider =
    stringField(metadata?.provider_name) ??
    stringField(errorRecord?.provider_name) ??
    stringField(errorRecord?.provider)
  const code = numberField(errorRecord?.code) ?? stringField(errorRecord?.code)
  const status =
    numberField(errorRecord?.status) ?? numberField(metadata?.status)
  const message =
    stringField(errorRecord?.message) ??
    errorText ??
    'The upstream provider failed while streaming this response.'

  const haystack = `${message} ${code ?? ''} ${finish ?? ''}`
  return {
    message: `Upstream provider error${provider ? ` (${provider})` : ''}: ${message}`,
    capacity: status === 429 || CAPACITY_PATTERN.test(haystack),
    ...(numberField(metadata?.retry_after_ms) && {
      retryAfterMs: numberField(metadata?.retry_after_ms),
    }),
    ...(provider && { provider }),
    ...(code !== undefined && { code }),
    ...(status !== undefined && { status }),
  }
}

/** Yield every chunk, throwing UpstreamStreamError when one reports failure. */
export async function* detectUpstreamFailures(
  chunks: AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>, void> {
  for await (const chunk of chunks) {
    const failure = upstreamFailureFromChunk(chunk)
    if (failure) throw new UpstreamStreamError(failure)
    yield chunk
  }
}
