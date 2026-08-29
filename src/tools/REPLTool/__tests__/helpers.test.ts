import { describe, test, expect } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ReplEngine } from '../engine.js'
import { getReplPrimitiveTools } from '../primitiveTools.js'
import type { ToolUseContext, Tools } from '../../../Tool.js'

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

const TMP = '/tmp/repl_helpers_test.txt'

describe('REPL file-edit helpers', () => {
  test('writeFile/editFile/viewFile/showDiff are exposed as REPL globals and persist + diff', async () => {
    rmSync(TMP, { force: true })
    const engine = new ReplEngine(getReplPrimitiveTools() as Tools, mockContext())
    const snippet = [
      "writeFile('" + TMP + "', 'hello world')",
      "editFile('" + TMP + "', 'hello', 'hi')",
      "viewFile('" + TMP + "')",
      "showDiff('foo', 'bar')",
    ].join('\n')
    const res = await engine.execute(snippet, 't')
    expect(res.result).toContain('Wrote ' + TMP)
    expect(res.result).toContain('+hello world')
    expect(res.result).toContain('-hello world')
    expect(res.result).toContain('+hi world')
    expect(res.result).toContain('1\thi world')
    expect(res.result).toContain('-foo')
    expect(res.result).toContain('+bar')
    expect(readFileSync(TMP, 'utf8')).toBe('hi world')
    rmSync(TMP, { force: true })
  })

  test('diffFile shows a +/- git diff for a tracked modified file', async () => {
    const repoRoot = '/home/yuki/Code/Agent/codev'
    const tmp = join(repoRoot, 'tmp_diff_test.txt')
    let res
    try {
      writeFileSync(tmp, 'line one\nline two\n')
      execSync('git -C ' + repoRoot + ' add ' + tmp)
      writeFileSync(tmp, 'line one\nline two added\n')
      const engine = new ReplEngine(getReplPrimitiveTools() as Tools, mockContext())
      res = await engine.execute("diffFile('" + tmp + "')", 't')
    } finally {
      execSync('git -C ' + repoRoot + ' rm --cached -f ' + tmp)
      rmSync(tmp, { force: true })
    }
    expect(res.result).toContain('line two added')
    expect(res.result).toContain('+')
  })

  test('raw primitive Write/Edit via callTool persist in REPL (readFileState priming)', async () => {
    rmSync(TMP, { force: true })
      const store = new Map<string, unknown>()
      const base = mockContext()
      const ctx: ToolUseContext = {
        ...base,
        readFileState: {
          get: (k: string) => store.get(k),
          set: (k: string, v: unknown) => {
            store.set(k, v)
          },
        } as ToolUseContext['readFileState'],
      }
    const engine = new ReplEngine(getReplPrimitiveTools() as Tools, ctx)
    const snippet = [
      "const w = await callTool('Write', { file_path: '" + TMP + "', content: 'WRITTEN' });",
      "console.log('WR_ERR:' + w.isError);",
      "const e = await callTool('Edit', { file_path: '" + TMP + "', old_string: 'WRITTEN', new_string: 'EDITED' });",
      "console.log('ED_ERR:' + e.isError);",
    ].join('\n')
    const res = await engine.execute(snippet, 't')
    expect(res.result).toContain('WR_ERR:false')
    expect(res.result).toContain('ED_ERR:false')
    expect(readFileSync(TMP, 'utf8')).toBe('EDITED')
    rmSync(TMP, { force: true })
  })
})
