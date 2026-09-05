import { describe, test, expect } from 'bun:test'

// Sub-agents must inherit the REPL/callTool capability (the `REPL` tool that
// proxies Read/Bash/Grep/Write/Edit via `await callTool(...)`), matching the
// main session. This guards the assembleToolPool({ forAgent: true }) wiring in
// AgentTool.tsx so a regression can't silently strip file/Shell access from
// spawned agents again.
//
// Dynamic imports avoid a module-init-order quirk when both src/tools.ts and
// src/Tool.ts are imported in the same module (static imports intermittently
// yield an incomplete permission context).
describe('sub-agent REPL/callTool exposure', () => {
  test('assembleToolPool({ forAgent: true }) surfaces REPLTool', async () => {
    const { assembleToolPool, getReplTool } = await import('../../../tools.js')
    const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
    const { REPL_TOOL_NAME } = await import('../../../tools/REPLTool/constants.js')

    const pool = assembleToolPool(getEmptyToolPermissionContext(), [], {
      forAgent: true,
    })
    const names = pool.map((t: { name: string }) => t.name)

    if (getReplTool()) {
      expect(names).toContain(REPL_TOOL_NAME)
    } else {
      // REPL disabled in this build: primitives must be directly present.
      expect(names.some((n: string) => /^(Read|Bash|Grep)$/.test(n))).toBe(true)
    }
  })

  test('wildcard sub-agent def resolves REPLTool', async () => {
    const { assembleToolPool } = await import('../../../tools.js')
    const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
    const { resolveAgentTools } = await import(
      '../agentToolUtils.js'
    )
    const { REPL_TOOL_NAME } = await import('../../../tools/REPLTool/constants.js')

    const pool = assembleToolPool(getEmptyToolPermissionContext(), [], {
      forAgent: true,
    })
    // Mimics GENERAL_PURPOSE_AGENT / VERIFICATION_AGENT (tools: ['*']).
    const resolved = resolveAgentTools(
      {
        tools: ['*'],
        disallowedTools: [],
        source: 'built-in',
        permissionMode: 'acceptEdits',
      },
      pool,
      false,
    )
    const resolvedNames = resolved.resolvedTools.map(
      (t: { name: string }) => t.name,
    )
    expect(resolvedNames).toContain(REPL_TOOL_NAME)
  })

  test('main-session pool (no forAgent) still assembles', async () => {
    const { assembleToolPool } = await import('../../../tools.js')
    const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
    const pool = assembleToolPool(getEmptyToolPermissionContext(), [])
    expect(Array.isArray(pool)).toBe(true)
  })

  test('async allow-list (Source of Truth) includes REPLTool', async () => {
    const { ASYNC_AGENT_ALLOWED_TOOLS, IN_PROCESS_TEAMMATE_ALLOWED_TOOLS } =
      await import('../../../constants/tools.js')
    const { REPL_TOOL_NAME } = await import(
      '../../../tools/REPLTool/constants.js'
    )
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has(REPL_TOOL_NAME)).toBe(true)
    expect(IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(REPL_TOOL_NAME)).toBe(true)
  })

  test('async Explore-style agent keeps REPLTool through filterToolsForAgent', async () => {
    const { assembleToolPool, getReplTool } = await import('../../../tools.js')
    const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
    const { resolveAgentTools } = await import('../agentToolUtils.js')
    const { REPL_TOOL_NAME } = await import(
      '../../../tools/REPLTool/constants.js'
    )
    const pool = assembleToolPool(getEmptyToolPermissionContext(), [], {
      forAgent: true,
    })
    const resolved = resolveAgentTools(
      {
        tools: undefined,
        disallowedTools: [],
        source: 'built-in',
        permissionMode: 'acceptEdits',
      },
      pool,
      true,
    )
    const names = resolved.resolvedTools.map((t) => t.name)
    if (getReplTool()) {
      expect(names).toContain(REPL_TOOL_NAME)
    } else {
      expect(names.some((n) => /^(Read|Bash|Grep)$/.test(n))).toBe(true)
    }
  })
})
