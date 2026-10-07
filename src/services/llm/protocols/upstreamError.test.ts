import { describe, expect, test } from 'bun:test'
import {
  detectUpstreamFailures,
  upstreamFailureFromChunk,
  UpstreamStreamError,
} from './upstreamError.js'

describe('upstreamFailureFromChunk', () => {
  test('ordinary content is not a failure', () => {
    expect(upstreamFailureFromChunk({ choices: [{ delta: { content: 'hi' } }] })).toBeUndefined()
    expect(upstreamFailureFromChunk({ choices: [{ finish_reason: 'stop' }] })).toBeUndefined()
  })

  test('an error frame carries provider, code and retry hint', () => {
    const failure = upstreamFailureFromChunk({
      error: {
        message: 'Provider returned error',
        code: 429,
        metadata: { provider_name: 'Acme', retry_after_ms: 2_000 },
      },
    })
    expect(failure).toBeDefined()
    expect(failure!.message).toContain('Acme')
    expect(failure!.message).toContain('Provider returned error')
    expect(failure!.capacity).toBe(true)
    expect(failure!.retryAfterMs).toBe(2_000)
    expect(failure!.code).toBe(429)
  })

  test('finish_reason error is a failure even without an error object', () => {
    const failure = upstreamFailureFromChunk({ choices: [{ finish_reason: 'error' }] })
    expect(failure).toBeDefined()
    expect(failure!.capacity).toBe(false)
    const native = upstreamFailureFromChunk({
      choices: [{ native_finish_reason: 'error' }],
    })
    expect(native).toBeDefined()
  })

  test('capacity wording classifies without a 429 status', () => {
    const failure = upstreamFailureFromChunk({
      error: { message: 'No capacity available right now, try again later' },
    })
    expect(failure!.capacity).toBe(true)
  })
})

describe('detectUpstreamFailures', () => {
  async function* iterate(chunks: Record<string, unknown>[]) {
    for (const chunk of chunks) yield chunk
  }

  async function collect(chunks: Record<string, unknown>[]): Promise<unknown[]> {
    const out: unknown[] = []
    for await (const chunk of detectUpstreamFailures(iterate(chunks))) out.push(chunk)
    return out
  }

  test('passes content through and throws on an error frame', async () => {
    const good = { choices: [{ delta: { content: 'a' } }] }
    expect(await collect([good, { choices: [{ finish_reason: 'stop' }] }])).toHaveLength(2)

    await expect(
      collect([good, { error: { message: 'boom', code: 503 } }]),
    ).rejects.toBeInstanceOf(UpstreamStreamError)
  })
})
