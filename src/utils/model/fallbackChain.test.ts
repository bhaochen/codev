import { describe, expect, test } from 'bun:test'
import { isFallbackEligibleError } from './fallbackChain.js'

describe('isFallbackEligibleError', () => {
  test('allows auth, quota, rate-limit, and server failures', () => {
    for (const status of [401, 402, 403, 429, 500, 503, 599]) {
      expect(isFallbackEligibleError({ status })).toBe(true)
    }
    expect(isFallbackEligibleError(new Error('Upstream openai failed (503): unavailable'))).toBe(true)
    expect(isFallbackEligibleError('unknown', 'API Error: 502 Bad Gateway')).toBe(true)
    expect(isFallbackEligibleError('authentication_failed')).toBe(true)
    expect(isFallbackEligibleError('rate_limit')).toBe(true)
  })

  test('does not fallback on request, model, or transport errors', () => {
    for (const status of [400, 404, 408, 422]) {
      expect(isFallbackEligibleError({ status })).toBe(false)
    }
    expect(isFallbackEligibleError(new TypeError('fetch failed'))).toBe(false)
    expect(isFallbackEligibleError(new Error('model not found'))).toBe(false)
  })
})
