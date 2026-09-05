import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

/**
 * REPL Toggle Correctness regression tests.
 *
 * Guards the static-initialization freeze:
 *   tools.ts (import) → isReplModeEnabled() → isConfigReadingAllowed()==false
 *   → default true → REPLTool frozen non-null → enableConfigs() reads
 *   replEnabled=false too late.
 *
 * After the fix, REPLTool registration is resolved at runtime via
 * getReplTool() + a defense-in-depth invariant in getTools(), so the
 * result is independent of import order (static-first vs config-first).
 *
 * NOTE: this file statically imports tools.ts at the top (static-first
 * order: import before enableConfigs). If the frozen-const regression
 * returns, the replEnabled=false cases below fail with REPL still present.
 */
import {
  getTools,
  getAllBaseTools,
  assembleToolPool,
  getReplTool,
} from '../../../tools.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import { REPL_TOOL_NAME } from '../constants.js'
import {
  enableConfigs,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../../utils/config.js'

const PRIMITIVES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']

function namesOf(tools: readonly { name: string }[]): string[] {
  return tools.map(t => t.name)
}

let savedCodevRepl: string | undefined
let savedClaudeCodeRepl: string | undefined
let savedReplEnabled: boolean | undefined

beforeEach(() => {
  savedCodevRepl = process.env.CODEV_REPL
  savedClaudeCodeRepl = process.env.CLAUDE_CODE_REPL
  delete process.env.CODEV_REPL
  delete process.env.CLAUDE_CODE_REPL
  // Allow config reads so isReplModeEnabled() observes the test config
  // instead of the pre-enableConfigs default-true.
  enableConfigs()
  savedReplEnabled = getGlobalConfig().replEnabled
})

afterEach(() => {
  if (savedCodevRepl === undefined) delete process.env.CODEV_REPL
  else process.env.CODEV_REPL = savedCodevRepl
  if (savedClaudeCodeRepl === undefined) delete process.env.CLAUDE_CODE_REPL
  else process.env.CLAUDE_CODE_REPL = savedClaudeCodeRepl
  if (savedReplEnabled !== undefined) {
    const v = savedReplEnabled
    saveGlobalConfig(current => ({ ...current, replEnabled: v }))
  }
})

function setReplEnabled(v: boolean): void {
  saveGlobalConfig(current => ({ ...current, replEnabled: v }))
}

describe('REPL toggle correctness', () => {
  test('replEnabled=false → REPL absent, primitives directly available', () => {
    setReplEnabled(false)
    const names = namesOf(getTools(getEmptyToolPermissionContext()))
    expect(names).not.toContain(REPL_TOOL_NAME)
    for (const p of PRIMITIVES) expect(names).toContain(p)
    expect(getReplTool()).toBeNull()
  })

  test('replEnabled=true → REPL present, primitives hidden from direct use', () => {
    setReplEnabled(true)
    const names = namesOf(getTools(getEmptyToolPermissionContext()))
    expect(names).toContain(REPL_TOOL_NAME)
    for (const p of PRIMITIVES) expect(names).not.toContain(p)
    expect(getReplTool()).not.toBeNull()
  })

  test('getAllBaseTools follows the toggle at runtime (no frozen const)', () => {
    setReplEnabled(false)
    expect(namesOf(getAllBaseTools())).not.toContain(REPL_TOOL_NAME)
    setReplEnabled(true)
    expect(namesOf(getAllBaseTools())).toContain(REPL_TOOL_NAME)
  })

  test('CODEV_REPL=0 forces REPL off even when config is on', () => {
    setReplEnabled(true)
    process.env.CODEV_REPL = '0'
    const names = namesOf(getTools(getEmptyToolPermissionContext()))
    expect(names).not.toContain(REPL_TOOL_NAME)
    for (const p of PRIMITIVES) expect(names).toContain(p)
  })

  test('CODEV_REPL=1 forces REPL on even when config is off', () => {
    setReplEnabled(false)
    process.env.CODEV_REPL = '1'
    const names = namesOf(getTools(getEmptyToolPermissionContext()))
    expect(names).toContain(REPL_TOOL_NAME)
    for (const p of PRIMITIVES) expect(names).not.toContain(p)
  })

  test('assembleToolPool({ forAgent: true }) respects the toggle', () => {
    setReplEnabled(false)
    const offPool = namesOf(
      assembleToolPool(getEmptyToolPermissionContext(), [], { forAgent: true }),
    )
    expect(offPool).not.toContain(REPL_TOOL_NAME)

    setReplEnabled(true)
    const onPool = namesOf(
      assembleToolPool(getEmptyToolPermissionContext(), [], { forAgent: true }),
    )
    expect(onPool).toContain(REPL_TOOL_NAME)
  })
})
