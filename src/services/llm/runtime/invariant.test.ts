import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'

describe('P6 invariants', () => {
  test('claude.ts deleted — queryModel is Facade to ModelRuntime', () => {
    // claude.ts has been eradicated; all helpers moved to llm/* and queryModel
    let claudeExists = true
    try {
      readFileSync('src/services/api/claude.ts', 'utf8')
    } catch {
      claudeExists = false
    }
    expect(claudeExists).toBe(false)
    const q = readFileSync('src/services/api/queryModel.ts', 'utf8')
    expect(q).toContain('modelRuntime.generate')
    expect(q).not.toContain('getAnthropicClient')
    expect(q).not.toMatch(/if\s*\(\s*getAPIProvider\(\)\s*===\s*['"]openai['"]/)
    expect(q).not.toMatch(/if\s*\(\s*getAPIProvider\(\)\s*===\s*['"]opencode['"]/)
    expect(q).not.toContain('No client for protocol')
    expect(q).not.toMatch(/anthropic-messages.*fallback/i)
    expect(q).not.toContain('tengu_off_switch_query')
  })
  test('ModelRuntime does not branch on provider', () => {
    const s = readFileSync('src/services/llm/runtime/ModelRuntime.ts', 'utf8')
    expect(s).not.toMatch(/provider\s*===\s*['"]/)
    expect(s).toContain('getClientForRoute')
    expect(s).toContain('resolveRoute')
  })
  test('runtime is unified on a single OpenAI-compatible protocol', () => {
    const s = readFileSync('src/services/llm/protocols/index.ts', 'utf8')
    expect(s).toContain('openai-compatible-chat')
    expect(s).toContain('queryOpenAICompatibleChat')
    expect(s).toContain('ProtocolRegistry')
    // The unified runtime registers exactly one protocol; legacy per-provider
    // protocols (anthropic-messages, openai-chat, …) are gone.
    expect(s).not.toContain("'anthropic-messages'")
    expect(s).not.toContain("'openai-chat'")
    const c = readFileSync('src/services/llm/clients/index.ts', 'utf8')
    expect(c).toContain('getProtocolHandler')
    expect(c).not.toMatch(/不经此注册表/)
  })
})
