import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  queryAnthropicMessages,
  usesNativeAnthropicStreaming,
} from './anthropicMessages.js'

const PREV_API_KEY = process.env.ANTHROPIC_API_KEY
const PREV_PROVIDER = process.env.CLAUDE_CODE_API_PROVIDER
const PREV_BETTER_PROVIDER = process.env.BETTER_CLAWD_API_PROVIDER
const PREV_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK
const PREV_SKIP_BEDROCK_AUTH = process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH
const PREV_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX
const PREV_FOUNDRY = process.env.CLAUDE_CODE_USE_FOUNDRY
const PREV_MACRO = (globalThis as any).MACRO
const PREV_FETCH = globalThis.fetch

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete (process.env as any)[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key-123'
  delete process.env.CLAUDE_CODE_API_PROVIDER
  delete process.env.BETTER_CLAWD_API_PROVIDER
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  // getUserAgent() reads the build-time MACRO global; stub it for tests.
  ;(globalThis as any).MACRO = { VERSION: '0.0.0-test', BUILD_TIME: 'test' }
})

afterEach(() => {
  ;(globalThis as any).MACRO = PREV_MACRO
  globalThis.fetch = PREV_FETCH
  if (PREV_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = PREV_API_KEY
  setEnv({
    CLAUDE_CODE_API_PROVIDER: PREV_PROVIDER,
    BETTER_CLAWD_API_PROVIDER: PREV_BETTER_PROVIDER,
    CLAUDE_CODE_USE_BEDROCK: PREV_BEDROCK,
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: PREV_SKIP_BEDROCK_AUTH,
    CLAUDE_CODE_USE_VERTEX: PREV_VERTEX,
    CLAUDE_CODE_USE_FOUNDRY: PREV_FOUNDRY,
  })
})

describe('usesNativeAnthropicStreaming provider gating', () => {
  test('firstParty resolves to native transport', () => {
    process.env.CLAUDE_CODE_API_PROVIDER = 'anthropic'
    expect(usesNativeAnthropicStreaming()).toBe(true)
  })

  test('Bedrock opts out to the legacy SDK path', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(usesNativeAnthropicStreaming()).toBe(false)
  })

  test('Vertex opts out to the legacy SDK path', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    expect(usesNativeAnthropicStreaming()).toBe(false)
  })

  test('Foundry opts out to the legacy SDK path', () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    expect(usesNativeAnthropicStreaming()).toBe(false)
  })

  test('local provider keeps the legacy SDK path (own base-URL routing)', () => {
    process.env.CLAUDE_CODE_API_PROVIDER = 'local'
    expect(usesNativeAnthropicStreaming()).toBe(false)
  })
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

function anthropicSseStream(): string {
  const frames: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_test_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n')
}

function sseResponse() {
  return new Response(anthropicSseStream(), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_test_1' },
  })
}

function buildRequest(fetchOverride: typeof fetch) {
  const model = 'claude-opus-4-6'
  return {
    route: {
      provider: 'firstParty',
      model,
      protocol: 'anthropic-messages',
      endpoint: undefined,
    } as never,
    request: {
      model,
      messages: [],
      systemPrompt: [],
      tools: [],
      signal: new AbortController().signal,
      config: { maxOutputTokens: 64 },
      context: {
        model,
        getToolPermissionContext: async () => ({}),
        agents: [],
        isNonInteractiveSession: true,
        querySource: 'test',
        hasAppendSystemPrompt: false,
        mcpTools: [],
        fetchOverride,
      },
    } as never,
  }
}

async function collectAssistant(fetchOverride: typeof fetch) {
  const { route, request } = buildRequest(fetchOverride)
  const seen: any[] = []
  for await (const item of queryAnthropicMessages(route, request)) {
    seen.push(item)
  }
  return seen.filter(i => i?.type === 'assistant')
}

describe('firstParty native streaming integration', () => {
  test('streams text through the native first-party endpoint', async () => {
    process.env.CLAUDE_CODE_API_PROVIDER = 'anthropic'
    const calls = stubFetch(async () => sseResponse())
    const assistant = await collectAssistant(globalThis.fetch)
    // Filter to inference calls: background model-capabilities refresh may
    // also hit global fetch and must not be confused with the query path.
    const msgCalls = calls.filter(c => c.url.endsWith('/v1/messages'))
    expect(msgCalls).toHaveLength(1)
    expect(msgCalls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(assistant).toHaveLength(1)
    const text = (assistant[0]!.message.content as any[])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
    expect(text).toBe('hello')
    expect(assistant[0]!.message.stop_reason).toBe('end_turn')
    expect(assistant[0]!.message.usage.output_tokens).toBe(4)
  }, 30000)
})

describe('Bedrock legacy streaming integration', () => {
  test('routes through the Bedrock SDK endpoint, not api.anthropic.com', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
    const calls = stubFetch(async () => sseResponse())
    // The Bedrock SDK speaks AWS event-stream framing, which the plain-SSE
    // mock cannot satisfy: the point under test is ROUTING (legacy SDK path
    // taken, native first-party endpoint untouched), so any terminal outcome
    // is acceptable as long as every inference call targets Bedrock.
    try {
      await collectAssistant(globalThis.fetch)
    } catch {
      // expected: mock cannot satisfy Bedrock wire framing
    }
    const inferenceCalls = calls.filter(
      c => c.url.includes('/v1/messages') || c.url.includes('bedrock'),
    )
    expect(inferenceCalls.length).toBeGreaterThan(0)
    for (const c of inferenceCalls) {
      expect(c.url).not.toContain('api.anthropic.com')
      expect(c.url).toContain('bedrock')
    }
  }, 30000)
})
