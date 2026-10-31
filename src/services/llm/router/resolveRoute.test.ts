import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { resolveRoute } from './resolveRoute.js'
import { getClientForRoute } from '../clients/index.js'
import { clearStoredProviderCache } from '../../../utils/model/providers.js'

describe('resolveRoute', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  const origEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-route-test-'))
    // Minimal config: no authProvider, no custom endpoints.
    await fs.writeFile(path.join(tmpDir, '.claude.json'), '{}', 'utf8')

    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    origEnv.CLAUDE_CODE_API_PROVIDER = process.env.CLAUDE_CODE_API_PROVIDER
    origEnv.BETTER_CLAWD_API_PROVIDER = process.env.BETTER_CLAWD_API_PROVIDER
    origEnv.CLAUDE_CODE_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK
    origEnv.CLAUDE_CODE_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_API_PROVIDER
    delete process.env.BETTER_CLAWD_API_PROVIDER
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    clearStoredProviderCache()
  })
  afterEach(async () => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
    clearStoredProviderCache()
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('no config → openai gateway / openai-compatible-chat / 9router', () => {
    const r = resolveRoute('test')
    expect(r.provider).toBe('openai')
    expect(r.protocol).toBe('openai-compatible-chat')
    expect(r.model).toBe('test')
    expect(r.endpoint).toBe('http://localhost:20128/v1/chat/completions')
  })

  test('legacy provider pins (nvidia/anthropic/bedrock) fail with a descriptive error', () => {
    // The runtime is unified on OpenAI-compatible endpoints; per-provider
    // definitions no longer exist.
    process.env.CLAUDE_CODE_API_PROVIDER = 'nvidia'
    expect(() => resolveRoute('test-nvidia')).toThrow(/no route definition/)
    process.env.CLAUDE_CODE_API_PROVIDER = 'anthropic'
    expect(() => resolveRoute('claude-sonnet-4-5')).toThrow(/no route definition/)
    process.env.CLAUDE_CODE_API_PROVIDER = 'openrouter'
    expect(() => resolveRoute('acme/model')).toThrow(/no route definition/)
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(() => resolveRoute('anthropic.claude-sonnet')).toThrow(/no route definition/)
  })

  test('explicit provider override resolves a cross-provider fallback route', () => {
    process.env.CLAUDE_CODE_API_PROVIDER = 'opencode'
    const r = resolveRoute({ provider: 'openai', model: 'gpt-5' })
    expect(r.provider).toBe('openai')
    expect(r.protocol).toBe('openai-compatible-chat')
    expect(r.model).toBe('gpt-5')
  })

  test('route-level provider override to a legacy provider fails loudly', () => {
    expect(() => resolveRoute({ provider: 'nvidia', model: 'x' })).toThrow(/no route definition/)
  })
})

describe('Client=Protocol', () => {
  test('openai and custom routes share the OpenAI-compatible client', async () => {
    const openaiRoute = { provider: 'openai' as const, protocol: 'openai-compatible-chat' as const, model: 'gpt-5', endpoint: 'http://localhost:20128/v1/chat/completions' }
    const customRoute = { provider: 'custom' as const, protocol: 'openai-compatible-chat' as const, model: 'x', endpoint: 'https://example.com/v1/chat/completions' }
    const c1 = getClientForRoute(openaiRoute)
    const c2 = getClientForRoute(customRoute)
    expect(c1).not.toBeNull()
    expect(c2).not.toBeNull()
    expect(c1).toBe(c2)
  })
})

describe('Route override (Phase 4)', () => {
  test('explicit protocol override preserved', () => {
    const r = resolveRoute({ model: 'gpt-5', protocol: 'openai-compatible-chat' })
    expect(r.provider).toBe('openai')
    expect(r.protocol).toBe('openai-compatible-chat')
    expect(r.model).toBe('gpt-5')
  })

  test('explicit endpoint override preserved', () => {
    const r = resolveRoute({ model: 'test', protocol: 'openai-compatible-chat', endpoint: 'https://example.com/v1' })
    expect(r.protocol).toBe('openai-compatible-chat')
    expect(r.endpoint).toBe('https://example.com/v1')
  })

  test('endpoint override does not affect provider default protocol when not specified', () => {
    const r = resolveRoute({ model: 'gpt-5', endpoint: 'https://example.com/v1' })
    expect(r.provider).toBe('openai')
    expect(r.protocol).toBe('openai-compatible-chat')
    expect(r.endpoint).toBe('https://example.com/v1')
  })

  test('Route → Client respects overridden protocol', () => {
    const r = resolveRoute({ model: 'gpt-5', protocol: 'openai-compatible-chat', endpoint: 'https://example.com/v1' })
    const c = getClientForRoute(r)
    expect(c).not.toBeNull()
    const compat = getClientForRoute({ provider: 'openai' as const, protocol: 'openai-compatible-chat' as const, model: 'x', endpoint: 'y' })
    expect(c).toBe(compat)
  })
})
