import { describe, test, expect } from 'bun:test'
import { computeNewLimitsFromHeaders } from './claudeAiLimits.js'

function quotaHeaders(entries: Record<string, string>): Headers {
  return new Headers({ 'Content-Type': 'application/json', ...entries })
}

describe('quota header interpretation', () => {
  test('allowed status with fallback available', () => {
    const limits = computeNewLimitsFromHeaders(
      quotaHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-fallback': 'available',
      }),
    )
    expect(limits.status).toBe('allowed')
    expect(limits.unifiedRateLimitFallbackAvailable).toBe(true)
    expect(limits.isUsingOverage).toBe(false)
  })

  test('rejected with allowed overage marks overage usage', () => {
    const limits = computeNewLimitsFromHeaders(
      quotaHeaders({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-overage-status': 'allowed',
        'anthropic-ratelimit-unified-overage-reset': '9999999999',
      }),
    )
    expect(limits.status).toBe('rejected')
    expect(limits.isUsingOverage).toBe(true)
    expect(limits.overageStatus).toBe('allowed')
  })

  test('missing headers default to allowed', () => {
    const limits = computeNewLimitsFromHeaders(quotaHeaders({}))
    expect(limits.status).toBe('allowed')
    expect(limits.resetsAt).toBeUndefined()
    expect(limits.isUsingOverage).toBe(false)
  })

  test('surpassed-threshold header triggers early warning', () => {
    const limits = computeNewLimitsFromHeaders(
      quotaHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-surpassed-threshold': '1',
        'anthropic-ratelimit-unified-5h-utilization': '0.95',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 17000),
      }),
    )
    expect(limits.status).toBe('allowed_warning')
    expect(limits.rateLimitType).toBe('five_hour')
    expect(limits.surpassedThreshold).toBe(1)
  })

  test('overage disabled reason is captured', () => {
    const limits = computeNewLimitsFromHeaders(
      quotaHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
      }),
    )
    expect(limits.overageDisabledReason).toBe('out_of_credits')
  })
})
