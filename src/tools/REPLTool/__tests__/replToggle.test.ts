import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * REPL always-on invariant regression tests.
 *
 * REPL is a base capability every agent needs — a programmable environment
 * with file/shell tool access inside the VM. So there is deliberately NO
 * toggle: no `replEnabled` config field, no CODEV_REPL / CLAUDE_CODE_REPL
 * env override, nothing that can strip it from the tool pool. These tests
 * guard that invariant — if a conditional registration sneaks back in
 * (reading config/env to conditionally skip REPL), they fail.
 *
 * REPL is also *additive*: enabling it never hides the primitive tools
 * (Read/Write/Edit/Glob/Grep/Bash) — they stay directly callable alongside
 * the programming environment.
 *
 * NOTE: this file statically imports tools.ts at the top (static-first
 * order: import before enableConfigs). REPL registration no longer depends
 * on config state, so import order cannot change the outcome; the static
 * import is kept so an accidental return to config-conditioned registration
 * is caught regardless of ordering.
 */
import {
  getTools,
  getAllBaseTools,
  assembleToolPool,
  getReplTool,
} from '../../../tools.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import { REPL_TOOL_NAME } from '../constants.js'
import { enableConfigs } from '../../../utils/config.js'

const PRIMITIVES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']

function namesOf(tools: readonly { name: string }[]): string[] {
  return tools.map(t => t.name)
}

beforeEach(() => {
  // Match the runtime context: config is enabled in the app, and tool-pool
  // assembly may read other settings. REPL presence itself must NOT depend
  // on any of this.
  enableConfigs()
})

describe('REPL always-on invariant', () => {
  test('REPL is always in getTools()', () => {
    const names = namesOf(getTools(getEmptyToolPermissionContext()))
    expect(names).toContain(REPL_TOOL_NAME)
  })

  test('primitive tools are never hidden by REPL (additive, not a gateway)', () => {
    const names = namesOf(getTools(getEmptyToolPermissionContext()))
    for (const p of PRIMITIVES) expect(names).toContain(p)
  })

  test('getReplTool() always resolves to a Tool', () => {
    expect(getReplTool()).not.toBeNull()
  })

  test('REPL is always in getAllBaseTools()', () => {
    expect(namesOf(getAllBaseTools())).toContain(REPL_TOOL_NAME)
  })

  test('assembleToolPool({ forAgent: true }) surfaces REPL for sub-agents', () => {
    const names = namesOf(
      assembleToolPool(getEmptyToolPermissionContext(), [], {
        forAgent: true,
      }),
    )
    expect(names).toContain(REPL_TOOL_NAME)
    for (const p of PRIMITIVES) expect(names).toContain(p)
  })
})