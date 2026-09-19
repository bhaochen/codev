import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { APIError } from '@anthropic-ai/sdk/error'
import {
  checkQuotaStatus,
  computeNewLimitsFromHeaders,
  makeTestQuery,
} from './claudeAiLimits.js'

const PREV_API_KEY = process.env.ANTHROPIC_API_KEY
const PREV_MACRO = (globalThis as any).MACRO
const PREV_FETCH = globalThis.fetch
const PREV_TRAFFIC = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key-123'
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  ;(globalThis as any).MACRO = { VERSION: '0.0.0-test', BUILD_TIME: 'test' }
})

afterEach(() => {
  ;(globalThis as any).MACRO = PREV_MACRO
  globalThis.fetch = PREV_FETCH
  if (PREV_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = PREV_API_KEY
  if (PREV_TRAFFIC === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = PREV_TRAFFIC
})

type CapturedCall = { url: string; init: RequestInit }

function stubFetch(handler: (url: any, init?: any) => Response | Promise<Response>) {
  const calls: CapturedCall[] = []
  ;(globalThis as any).fetch = async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} })
    return handler(url, init)
  }
  return calls
}

function quotaHeaders(entries: Record<string, string>): Headers {
  return new Headers({ 'Content-Type': 'application/json', ...entries })
}

function okResponse(headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
    { status: 200, headers: quotaHeaders(headers) },
  )
}

describe('native quota test query', () => {
  test('sends a minimal non-streaming message request', async () => {
    const calls = stubFetch(async () => okResponse())
    const raw = await makeTestQuery()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/messages$/)
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'quota' }])
    expect(body.stream).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('x-api-key')).toBe('test-key-123')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(raw.headers).toBeInstanceOf(Headers)
  })

  test('auth failure surfaces APIError with status', async () => {
    stubFetch(async () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const err = await makeTestQuery().then(
      () => null,
      e => e,
    )
    expect(err).toBeInstanceOf(APIError)
    expect((err as APIError).status).toBe(401)
  })

  test('transport errors propagate (checkQuotaStatus swallows non-APIError)', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(makeTestQuery()).rejects.toThrow('fetch failed')
  })
})

describe('checkQuotaStatus gating', () => {
  test('essential-traffic mode skips the network call', async () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    const calls = stubFetch(async () => okResponse())
    await checkQuotaStatus()
    expect(calls).toHaveLength(0)
  })

  test('non-subscriber without mocks skips the network call', async () => {
    const calls = stubFetch(async () => okResponse())
    await checkQuotaStatus()
    expect(calls).toHaveLength(0)
  })
})

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

describe('api/client decoupling invariants', () => {
  test('claudeAiLimits no longer references the legacy client factory', () => {
    const source = readFileSync('src/services/claudeAiLimits.ts', 'utf8')
    expect(source).not.toMatch(/getAnthropicClient\(/)
    expect(source).toContain('nativeAnthropicPost')
  })
})
