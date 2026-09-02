import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolveRoute } from './resolveRoute.js'
import { getClientForRoute } from '../clients/index.js'

describe('resolveRoute', () => {
  const origEnv: Record<string, string | undefined> = {}
  beforeEach(() => {
    origEnv.CLAUDE_CODE_API_PROVIDER = process.env.CLAUDE_CODE_API_PROVIDER
    origEnv.BETTER_CLAWD_API_PROVIDER = process.env.BETTER_CLAWD_API_PROVIDER
    origEnv.CLAUDE_CODE_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK
    origEnv.CLAUDE_CODE_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_API_PROVIDER
    delete process.env.BETTER_CLAWD_API_PROVIDER
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
  })

  test('no config → opencode / fallback model / openai-chat', () => {
    const r = resolveRoute('test')
    expect(r.provider).toBe('opencode')
    expect(r.protocol).toBe('openai-chat')
    expect(r.model).toBe('test')
  })

  test('OpenAI configured → openai / openai-chat', () => {
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    const r = resolveRoute('gpt-5')
    expect(r.provider).toBe('openai')
    expect(r.protocol).toBe('openai-chat')
    expect(r.model).toBe('gpt-5')
  })

  test('Anthropic firstParty → firstParty / anthropic-messages', () => {
    process.env.CLAUDE_CODE_API_PROVIDER = 'anthropic'
    const r = resolveRoute('claude-sonnet-4-5')
    expect(r.provider).toBe('firstParty')
    expect(r.protocol).toBe('anthropic-messages')
  })

  test('NVIDIA → nvidia / openai-chat (migrated native)', () => {
    process.env.CLAUDE_CODE_API_PROVIDER = 'nvidia'
    const r = resolveRoute('test-nvidia')
    expect(r.provider).toBe('nvidia')
    expect(r.protocol).toBe('openai-chat')
  })

  test('Bedrock → bedrock / anthropic-messages', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const r = resolveRoute('anthropic.claude-sonnet')
    expect(r.provider).toBe('bedrock')
    expect(r.protocol).toBe('anthropic-messages')
  })
})

describe('Client=Protocol', () => {
  test('OpenAI/OpenCode/DeepSeek → same OpenAIChatClient', async () => {
    const openaiRoute = { provider: 'openai' as const, protocol: 'openai-chat' as const, model: 'gpt-5', endpoint: 'https://api.openai.com/v1/chat/completions' }
    const opencodeRoute = { provider: 'opencode' as const, protocol: 'openai-chat' as const, model: 'big-pickle', endpoint: 'https://opencode.ai/zen/v1/chat/completions' }
    const c1 = getClientForRoute(openaiRoute)
    const c2 = getClientForRoute(opencodeRoute)
    expect(c1).not.toBeNull()
    expect(c2).not.toBeNull()
    expect(c1).toBe(c2)
  })
})
