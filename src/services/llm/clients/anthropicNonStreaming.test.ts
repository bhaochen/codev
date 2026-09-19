import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { APIError, APIUserAbortError, APIConnectionTimeoutError } from '@anthropic-ai/sdk/error'
import { CannotRetryError } from '../../api/withRetry.js'
import {
  executeNonStreamingRequest,
  verifyApiKey,
  queryAnthropicMessages,
} from './anthropicMessages.js'

const PREV_API_KEY = process.env.ANTHROPIC_API_KEY
const PREV_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN
const PREV_TIMEOUT = process.env.API_TIMEOUT_MS
const PREV_MAX_RETRIES = process.env.CLAUDE_CODE_MAX_RETRIES
const PREV_MACRO = (globalThis as any).MACRO

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key-123'
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.API_TIMEOUT_MS
  delete process.env.CLAUDE_CODE_MAX_RETRIES
  // getUserAgent() reads the build-time MACRO global; stub it for tests.
  ;(globalThis as any).MACRO = { VERSION: '0.0.0-test', BUILD_TIME: 'test' }
})

afterEach(() => {
  ;(globalThis as any).MACRO = PREV_MACRO
  if (PREV_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = PREV_API_KEY
  if (PREV_AUTH_TOKEN === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
  else process.env.ANTHROPIC_AUTH_TOKEN = PREV_AUTH_TOKEN
  if (PREV_TIMEOUT === undefined) delete process.env.API_TIMEOUT_MS
  else process.env.API_TIMEOUT_MS = PREV_TIMEOUT
  if (PREV_MAX_RETRIES === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES
  else process.env.CLAUDE_CODE_MAX_RETRIES = PREV_MAX_RETRIES
})

type CapturedCall = { url: string; init: RequestInit }

function betaMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: 'hello' }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    },
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function baseRetryParams() {
  return {
    model: 'claude-test',
    max_tokens: 5,
    messages: [{ role: 'user', content: 'hi' }],
  } as any
}

function runFallback(fetchOverride: (url: any, init?: any) => Promise<Response>, retryParams: any = baseRetryParams()) {
  const calls: CapturedCall[] = []
  const wrapped = async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} })
    return fetchOverride(url, init)
  }
  const gen = executeNonStreamingRequest(
    { model: 'claude-test', fetchOverride: wrapped as any, source: 'test' },
    {
      model: 'claude-test',
      thinkingConfig: { type: 'disabled' },
      signal: new AbortController().signal,
    } as any,
    () => retryParams,
    () => {},
    () => {},
  )
  return { gen, calls }
}

async function drain<T>(gen: AsyncGenerator<any, T>): Promise<T> {
  let e = await gen.next()
  while (!e.done) e = await gen.next()
  return e.value as T
}

describe('native non-streaming fallback', () => {
  test('success returns parsed BetaMessage with usage and stop_reason', async () => {
    const { gen, calls } = runFallback(async () => jsonResponse(betaMessage()))
    const result: any = await drain(gen)
    expect(result.stop_reason).toBe('end_turn')
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/messages$/)
  })

  test('tool schemas and thinking pass through untouched', async () => {
    const tools = [{ name: 't', description: 'd', input_schema: { type: 'object' } }]
    const { gen, calls } = runFallback(
      async () => jsonResponse(betaMessage()),
      {
        ...baseRetryParams(),
        tools,
        thinking: { type: 'enabled', budget_tokens: 100 },
        max_tokens: 1000,
      },
    )
    await drain(gen)
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.tools).toEqual(tools)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 100 })
    expect(body.stream).toBeUndefined()
  })

  test('betas go to header, not body', async () => {
    const { gen, calls } = runFallback(
      async () => jsonResponse(betaMessage()),
      { ...baseRetryParams(), betas: ['x-test-beta'] },
    )
    await drain(gen)
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.betas).toBeUndefined()
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('anthropic-beta')).toBe('x-test-beta')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('x-api-key')).toBe('test-key-123')
  })

  test('non-ok response surfaces APIError with status', async () => {
    const { gen } = runFallback(async () =>
      jsonResponse({ type: 'error', error: { type: 'invalid_request', message: 'bad' } }, 400),
    )
    const err = await drain(gen).then(
      () => null,
      e => e,
    )
    expect(err).toBeInstanceOf(CannotRetryError)
    expect((err as CannotRetryError).originalError).toBeInstanceOf(APIError)
    expect(((err as CannotRetryError).originalError as APIError).status).toBe(400)
  })

  test('aborted signal raises APIUserAbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    const gen = executeNonStreamingRequest(
      { model: 'claude-test', fetchOverride: (async () => jsonResponse(betaMessage())) as any, source: 'test' },
      { model: 'claude-test', thinkingConfig: { type: 'disabled' }, signal: controller.signal } as any,
      () => baseRetryParams(),
      () => {},
      () => {},
    )
    await expect(drain(gen)).rejects.toBeInstanceOf(APIUserAbortError)
  })

  test('hung request hits timeout as APIConnectionTimeoutError', async () => {
    process.env.API_TIMEOUT_MS = '50'
    process.env.CLAUDE_CODE_MAX_RETRIES = '0'
    const hanging = (_url: any, init?: any) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    const { gen } = runFallback(hanging)
    const err = await drain(gen).then(
      () => null,
      e => e,
    )
    const root =
      err instanceof CannotRetryError ? (err.originalError as Error) : (err as Error)
    expect(root).toBeInstanceOf(APIConnectionTimeoutError)
  }, 15000)
})

describe('verifyApiKey over native transport', () => {
  const PREV_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = PREV_FETCH
  })

  function stubFetch(handler: (url: any, init?: any) => Response | Promise<Response>) {
    const calls: CapturedCall[] = []
    ;(globalThis as any).fetch = async (url: any, init?: any) => {
      calls.push({ url: String(url), init: init ?? {} })
      return handler(url, init)
    }
    return calls
  }

  test('valid key returns true and sends the passed key, not the env key', async () => {
    const calls = stubFetch(async () => jsonResponse(betaMessage()))
    const ok = await verifyApiKey('verify-key-abc', false)
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/messages$/)
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('x-api-key')).toBe('verify-key-abc')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'test' }])
    expect(body.stream).toBeUndefined()
  })

  test('invalid key returns false', async () => {
    stubFetch(async () =>
      jsonResponse(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        401,
      ),
    )
    await expect(verifyApiKey('bad-key', false)).resolves.toBe(false)
  })

  test('non-auth API error is thrown', async () => {
    stubFetch(async () =>
      jsonResponse({ type: 'error', error: { type: 'invalid_request', message: 'bad' } }, 400),
    )
    await expect(verifyApiKey('verify-key-abc', false)).rejects.toMatchObject({ status: 400 })
  })

  test('non-interactive session skips the network call', async () => {
    const calls = stubFetch(async () => jsonResponse(betaMessage()))
    await expect(verifyApiKey('verify-key-abc', true)).resolves.toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('api/client decoupling invariants', () => {
  test('main streaming path does not call getAnthropicClient', () => {
    expect(queryAnthropicMessages.toString()).not.toContain('getAnthropicClient')
  })

  test('non-streaming fallback no longer calls getAnthropicClient', () => {
    expect(executeNonStreamingRequest.toString()).not.toContain('getAnthropicClient')
  })

  test('verifyApiKey no longer calls getAnthropicClient', () => {
    expect(verifyApiKey.toString()).not.toContain('getAnthropicClient')
  })

  test('only the Bedrock/Vertex/Foundry branches keep the legacy client', () => {
    const source = readFileSync('src/services/llm/clients/anthropicMessages.ts', 'utf8')
    const matches = source.match(/getAnthropicClient\(/g) ?? []
    // Dynamic imports inside getLegacyNonStreamingClient +
    // getLegacyStreamingClient only
    expect(matches).toHaveLength(2)
    expect(source).toContain('usesLegacySdkProvider')
    expect(source).toContain('usesNativeAnthropicStreaming')
  })

  test('main streaming path is provider-gated', () => {
    expect(queryAnthropicMessages.toString()).toContain('usesNativeAnthropicStreaming')
  })
})
