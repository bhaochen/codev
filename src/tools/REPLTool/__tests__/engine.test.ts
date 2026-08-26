import { describe, test, expect, beforeEach } from 'bun:test'
import { ReplEngine } from '../engine.js'
import type { ToolUseContext, Tools } from '../../../Tool.js'

// 最小化的 mock ToolUseContext
function mockContext(): ToolUseContext {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test',
      tools: [],
      verbose: false,
      thinkingConfig: { enabled: false },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { agents: [], frontmatter: {} },
    },
    abortController: new AbortController(),
    readFileState: { get: () => undefined, set: () => {} } as any,
    getAppState: () => ({}) as any,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as ToolUseContext
}

describe('ReplEngine', () => {
  let engine: ReplEngine

  beforeEach(() => {
    // 使用空工具列表（测试基本 VM 功能）
    engine = new ReplEngine([] as Tools, mockContext())
  })

  test('基本代码执行', async () => {
    const result = await engine.execute('1 + 1', 'test-1')
    expect(result.toolCalls).toBe(0)
    expect(result.output).toBe('2')
  })

  test('console.log 输出捕获', async () => {
    const result = await engine.execute('console.log("hello world")', 'test-1')
    expect(result.output).toBe('hello world')
    expect(result.result).toBe('hello world')
  })

  test('console.error 输出捕获', async () => {
    const result = await engine.execute('console.error("error msg")', 'test-1')
    expect(result.output).toBe('[ERROR] error msg')
  })

  test('跨调用状态持久化', async () => {
    await engine.execute('var x = 42', 'test-1')
    const result = await engine.execute('console.log(x)', 'test-2')
    expect(result.output).toBe('42')
  })

  test('超时保护（死循环）', async () => {
    const result = await engine.execute('while(true) {}', 'test-1', undefined, 100)
    expect(result.result).toContain('Error')
  })

  test('安全边界：eval 被禁止', async () => {
    const result = await engine.execute('eval("1+1")', 'test-1')
    expect(result.result).toContain('Error')
  })

  test('安全边界：process 被禁止', async () => {
    const result = await engine.execute('process.exit()', 'test-1')
    expect(result.result).toContain('Error')
  })

  test('JSON/Math/Date 可用', async () => {
    const result = await engine.execute(
      'console.log(JSON.stringify({a: 1})); console.log(Math.PI); console.log(new Date().getFullYear())',
      'test-1',
    )
    expect(result.output).toContain('{"a":1}')
    expect(result.output).toContain('3.14')
  })

  test('reset 清除状态', async () => {
    await engine.execute('var y = 100', 'test-1')
    engine.reset()
    const result = await engine.execute('typeof y', 'test-2')
    expect(result.output).toBe('undefined')
  })
})

describe('ReplEngine callTool', () => {
  test('callTool 不存在的工具返回错误', async () => {
    const engine = new ReplEngine([] as Tools, mockContext())
    // callTool 是异步的，需要在 VM 中 await
    const result = await engine.execute(
      'await callTool("nonexistent", {}).then(r => console.log(r.data))',
      'test-1',
    )
    expect(result.output).toContain('not found')
  })
})
