import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'

describe('P6 invariants', () => {
  test('claude.ts is Facade only depends on ModelRuntime', () => {
    const s = readFileSync('src/services/api/claude.ts', 'utf8')
    // 必须通过 ModelRuntime 委派
    expect(s).toContain('modelRuntime.generate')
    // 不应再出现 Provider 分支
    expect(s).not.toMatch(/if\s*\(\s*getAPIProvider\(\)\s*===\s*['"]openai['"]/)
    expect(s).not.toMatch(/if\s*\(\s*getAPIProvider\(\)\s*===\s*['"]opencode['"]/)
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
  })
})
