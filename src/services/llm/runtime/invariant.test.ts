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
    // P6.x: 不应再包含 Anthropic SDK fallback（已收敛至 anthropicMessages 协议客户端）
    expect(s).not.toContain('No client for protocol')
    expect(s).not.toMatch(/anthropic-messages.*fallback/i)
    // facade 后的 queryModel 不应包含原 fallback 的关键逻辑
    expect(s).not.toContain('tengu_off_switch_query')
    // 仍保留 helper 导入 getAnthropicClient 供 executeNonStreamingRequest 等，但 queryModel 本体不再直接使用
    const queryModelIdx = s.indexOf('export async function* queryModel(')
    // 跳过 queryModelWithStreaming 的干扰，定位真正的 queryModel
    const realIdx = s.indexOf('export async function* queryModel(\n  messages', queryModelIdx)
    const afterQueryModel = s.slice(realIdx !== -1 ? realIdx : queryModelIdx, (realIdx !== -1 ? realIdx : queryModelIdx) + 600)
    expect(afterQueryModel).toContain('modelRuntime.generate')
    expect(afterQueryModel).not.toContain('getAnthropicClient')
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
