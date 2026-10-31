import { describe, test, expect } from 'bun:test'
import { adaptToTokenRateLimit } from './openaiCompatibleChat.js'

describe('adaptToTokenRateLimit', () => {
  test('OTPM body → clamp output to the quoted limit, no wait', () => {
    const body = JSON.stringify({
      error: {
        message:
          "Request too large for model `m` on output tokens per minute (OTPM): Limit 1000, Requested 1171. The request's expected output tokens exceed the enforced limit; reduce max_tokens (or the request's expected output) and try again.",
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    })
    const r = adaptToTokenRateLimit(body, 16384)
    expect(r).toBeDefined()
    expect(r!.outputLimit).toBe(1000)
    expect(r!.waitMs).toBe(0)
  })

  test('ITPM body → wait for the quoted window, no output clamp', () => {
    const body = JSON.stringify({
      error: {
        message:
          'Rate limit reached for model `m` on input tokens per minute (ITPM): Limit 7000, Used 4339, Requested 4339. Please try again in 14.382857142s.',
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    })
    const r = adaptToTokenRateLimit(body, 16384)
    expect(r).toBeDefined()
    expect(r!.outputLimit).toBeUndefined()
    expect(r!.waitMs).toBeGreaterThanOrEqual(14300)
    expect(r!.waitMs).toBeLessThanOrEqual(14500)
  })

  test('non-token 429 → undefined (generic retry handles it)', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached, too many requests', code: 'rate_limit_exceeded' } })
    expect(adaptToTokenRateLimit(body, 4096)).toBeUndefined()
  })
})
