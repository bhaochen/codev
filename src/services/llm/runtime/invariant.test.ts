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
  test('Client is Protocol-oriented', () => {
    const s = readFileSync('src/services/llm/clients/openaiChat.ts', 'utf8')
    // Client 不应判断具体 Provider 语义，仅使用 route/protocol
    expect(s).not.toMatch(/if\s*\(\s*route\.provider\s*===\s*['"]openai['"]/)
    expect(s).not.toMatch(/if\s*\(\s*route\.provider\s*===\s*['"]opencode['"]/)
    expect(s).toContain('route.endpoint')
    expect(s).toContain('resolveAuth')
    // AnthropicMessages 同样不应分支 provider
    const s2 = readFileSync('src/services/llm/clients/anthropicMessages.ts', 'utf8')
    expect(s2).toContain('queryAnthropicMessages')
    expect(s2).toContain('route.model')
    expect(s2).not.toMatch(/if\s*\(\s*route\.provider\s*===\s*['"]/)
    expect(s2).not.toMatch(/if\s*\(\s*route\.provider\s*===\s*['"]openai['"]/)
  })
  test('anthropic-messages registered via ClientRegistry', () => {
    const s = readFileSync('src/services/llm/clients/index.ts', 'utf8')
    expect(s).toContain('anthropic-messages')
    expect(s).toContain('queryAnthropicMessages')
    expect(s).not.toMatch(/不经此注册表/)
  })
})
