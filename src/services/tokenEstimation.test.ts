import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
} from './tokenEstimation.js'

const PREV_API_KEY = process.env.ANTHROPIC_API_KEY
const PREV_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN
const PREV_PROVIDER = process.env.CLAUDE_CODE_API_PROVIDER
const PREV_BETTER_PROVIDER = process.env.BETTER_CLAWD_API_PROVIDER
const PREV_MACRO = (globalThis as any).MACRO
const PREV_FETCH = globalThis.fetch

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key-123'
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.BETTER_CLAWD_API_PROVIDER
  process.env.CLAUDE_CODE_API_PROVIDER = 'anthropic'
  // Keep VCR fixtures out of the repo: each run gets a fresh miss + record.
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = mkdtempSync(join(tmpdir(), 'tok-vcr-'))
  ;(globalThis as any).MACRO = { VERSION: '0.0.0-test', BUILD_TIME: 'test' }
})

afterEach(() => {
  ;(globalThis as any).MACRO = PREV_MACRO
  globalThis.fetch = PREV_FETCH
  if (PREV_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = PREV_API_KEY
  if (PREV_AUTH_TOKEN === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
  else process.env.ANTHROPIC_AUTH_TOKEN = PREV_AUTH_TOKEN
  if (PREV_PROVIDER === undefined) delete process.env.CLAUDE_CODE_API_PROVIDER
  else process.env.CLAUDE_CODE_API_PROVIDER = PREV_PROVIDER
  if (PREV_BETTER_PROVIDER === undefined) delete process.env.BETTER_CLAWD_API_PROVIDER
  else process.env.BETTER_CLAWD_API_PROVIDER = PREV_BETTER_PROVIDER
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('native countMessagesTokensWithAPI', () => {
  test('returns input_tokens from the count_tokens endpoint', async () => {
    const calls = stubFetch(async () => jsonResponse({ input_tokens: 42 }))
    const result = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'hello' }] as any,
      [],
    )
    expect(result).toBe(42)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/messages\/count_tokens$/)
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('x-api-key')).toBe('test-key-123')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.stream).toBeUndefined()
    expect(body.betas).toBeUndefined()
  })

  test('tools-only request sends a dummy message', async () => {
    const tools = [{ name: 't', description: 'd', input_schema: { type: 'object' } }]
    const calls = stubFetch(async () => jsonResponse({ input_tokens: 7 }))
    const result = await countMessagesTokensWithAPI([], tools as any)
    expect(result).toBe(7)
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.messages).toEqual([{ role: 'user', content: 'foo' }])
    expect(body.tools).toEqual(tools)
  })

  test('non-numeric usage returns null', async () => {
    stubFetch(async () => jsonResponse({ input_tokens: 'many' }))
    const result = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'hello' }] as any,
      [],
    )
    expect(result).toBeNull()
  })

  test('API failure returns null', async () => {
    stubFetch(async () => jsonResponse({ type: 'error' }, 500))
    const result = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'hello' }] as any,
      [],
    )
    expect(result).toBeNull()
  })
})

describe('native countTokensViaHaikuFallback', () => {
  test('sums input and cache tokens from a non-streaming message call', async () => {
    const calls = stubFetch(async () =>
      jsonResponse({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 4,
        },
      }),
    )
    const result = await countTokensViaHaikuFallback(
      [{ role: 'user', content: 'hello' }] as any,
      [],
    )
    expect(result).toBe(16)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/messages$/)
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.stream).toBeUndefined()
    expect(body.max_tokens).toBe(1)
  })
})

describe('tokenEstimation api/client decoupling invariants', () => {
  test('no direct getAnthropicClient calls outside the legacy branch helper', () => {
    const source = readFileSync('src/services/tokenEstimation.ts', 'utf8')
    const matches = source.match(/getAnthropicClient\(/g) ?? []
    // Single dynamic import inside getLegacyTokenClient only
    expect(matches).toHaveLength(1)
    expect(source).toContain('usesLegacyTokenProvider')
  })

  test('native paths do not reference the legacy client factory', () => {
    // countMessagesTokensWithAPI and countTokensViaHaikuFallback bodies
    // must not mention getAnthropicClient; only getLegacyTokenClient does.
    const source = readFileSync('src/services/tokenEstimation.ts', 'utf8')
    const idx = source.indexOf('export async function countMessagesTokensWithAPI')
    expect(idx).toBeGreaterThan(-1)
    const tail = source.slice(idx)
    expect(tail).not.toMatch(/[^a-zA-Z]getAnthropicClient\(/)
  })
})
