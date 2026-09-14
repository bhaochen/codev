import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, type EngineDeps, type RlmProgress } from '../engine.js'
import type { RlmConfig } from '../types.js'
import type { ChatMsg, CompleteResult, AdapterDeps, CompleteFn } from '../adapter.js'

function makeConfig(overrides: Partial<RlmConfig> = {}): RlmConfig {
  return {
    maxDepth: 2,
    maxIterations: 3,
    execTimeoutS: 10,
    requestTimeoutMs: 30_000,
    maxPromptChars: 400_000,
    python: 'python3',
    sandboxInitTimeoutMs: 10_000,
    compaction: false,           // skip compaction for simplicity
    enableVerificationNudge: false,
    ...overrides,
  }
}

const FAKE_ADAPTER: AdapterDeps = {
  model: 'test-model',
  signal: AbortSignal.timeout(60_000),
  getToolPermissionContext: async () => ({} as any),
  querySource: 'test' as any,
}

function mockComplete(fn: (history: readonly ChatMsg[]) => CompleteResult): CompleteFn {
  return async (history: readonly ChatMsg[]) => {
    // Strip system messages — only send user/assistant to the mock
    return fn(history)
  }
}

describe('RLM engine — smoke test (real Python sandbox)', () => {
  test('single turn: answer dict flip terminates run', async () => {
    let callN = 0
    const complete = mockComplete(() => {
      callN++
      return {
        text: '```repl\nanswer["content"] = "the answer is 42"\nanswer["ready"] = True\n```\nDone.',
        usage: { input: 100, output: 50, totalTokens: 150 },
      }
    })

    const deps: EngineDeps = {
      config: makeConfig(),
      adapter: FAKE_ADAPTER,
      complete,
      onEvent: () => {},      // silent
      onUsage: () => {},
    }

    const engine = createEngine(deps)
    const result = await engine({
      rootPrompt: 'What is the meaning of life?',
      context: [],
      depth: 0,
    })

    expect(result.answer).toContain('the answer is 42')
    expect(result.iterations).toBe(1)
    expect(callN).toBe(1)     // answer detected on first turn, no second call
  })

  test('two turns: code + no answer on first, answer on second', async () => {
    let callN = 0
    const complete = mockComplete(() => {
      callN++
      if (callN === 1) {
        return {
          text: '```repl\nx = 10\nprint(x)\n```\nOkay, computed x.',
          usage: { input: 100, output: 50, totalTokens: 150 },
        }
      }
      return {
        text: '```repl\nanswer["content"] = str(x + 1)\nanswer["ready"] = True\n```\nFinal.',
        usage: { input: 200, output: 60, totalTokens: 260 },
      }
    })

    const deps: EngineDeps = {
      config: makeConfig(),
      adapter: FAKE_ADAPTER,
      complete,
      onEvent: () => {},
      onUsage: () => {},
    }

    const engine = createEngine(deps)
    const result = await engine({
      rootPrompt: 'Compute x+1',
      context: [],
      depth: 0,
    })

    expect(result.answer).toBe('11')
    expect(result.iterations).toBe(2)
    expect(callN).toBe(2)
  })

  test('no answer and maxIterations exhausted → finalize called', async () => {
    let callN = 0
    const complete = mockComplete(() => {
      callN++
      return {
        text: '```repl\nprint("thinking...")\n```\nStill thinking.',
        usage: { input: 100, output: 50, totalTokens: 150 },
      }
    })

    const deps: EngineDeps = {
      config: makeConfig({ maxIterations: 2 }),
      adapter: FAKE_ADAPTER,
      complete,
      onEvent: () => {},
      onUsage: () => {},
    }

    const engine = createEngine(deps)
    const result = await engine({
      rootPrompt: 'Run some analysis',
      context: [],
      depth: 0,
    })

    // finalize() is called at the end — it makes one more complete call
    expect(result.iterations).toBe(2)
    expect(callN).toBe(3)     // 2 turns + 1 finalize
    expect(result.answer.length).toBeGreaterThan(0)
  })

  test('onEvent is called with correct phases', async () => {
    const phases: RlmProgress[] = []
    const complete = mockComplete(() => ({
      text: '```repl\nanswer["content"] = "ok"\nanswer["ready"] = True\n```',
      usage: { input: 50, output: 20, totalTokens: 70 },
    }))

    const deps: EngineDeps = {
      config: makeConfig(),
      adapter: FAKE_ADAPTER,
      complete,
      onEvent: (e) => phases.push(e),
      onUsage: () => {},
    }

    const engine = createEngine(deps)
    await engine({ rootPrompt: 'test', context: [], depth: 0 })

    expect(phases[0]?.phase).toBe('start')
    expect(phases.some((p) => p.phase === 'turn')).toBe(true)
    expect(phases.some((p) => p.phase === 'answer')).toBe(true)
    expect(phases.at(-1)?.phase).toBe('done')
  })

  test('llm_query sub-call is serviced by the engine interrupt handlers', async () => {
    let callN = 0
    const subPrompts: string[] = []
    const complete = mockComplete((history) => {
      callN++
      // Root turn → return repl block with await_task(llm_query(...))
      if (callN === 1) {
        return {
          text: '```repl\nx = await_task(llm_query("1+1?"))\nprint(x)\nanswer["content"] = x\nanswer["ready"] = True\n```\nQuerying.',
          usage: { input: 100, output: 50, totalTokens: 150 },
        }
      }
      // subLlmQuery — single user message whose content IS the sub-prompt.
      if (callN === 2) {
        const userMsg = history.findLast((m) => m.role === 'user')
        if (userMsg) subPrompts.push(userMsg.content)
        return { text: '2', usage: { input: 10, output: 5, totalTokens: 15 } }
      }
      throw new Error(`unexpected call ${callN}`)
    })

    const deps: EngineDeps = {
      config: makeConfig(),
      adapter: FAKE_ADAPTER,
      complete,
      onEvent: () => {},
      onUsage: () => {},
    }

    const engine = createEngine(deps)
    const result = await engine({ rootPrompt: 'use sub-llm', context: [], depth: 0 })

    // The sub-LLM answered '2', and x was printed and captured in the answer.
    expect(result.answer).toBe('2')
    // The interrupt was serviced — mock saw the exact sub-prompt as a bare user message.
    expect(subPrompts).toContain('1+1?')
  })

  test('add_context: host packs a local dir; worker appends into context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlm-addctx-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha beta gamma')
      await writeFile(join(dir, 'b.txt'), 'delta')
      const complete = mockComplete(() => ({
        text:
          '```repl\n' +
          `r = add_context(${JSON.stringify(dir)})\n` +
          'answer["content"] = str(len(context))\n' +
          'answer["ready"] = True\n' +
          '```',
        usage: { input: 100, output: 50, totalTokens: 150 },
      }))

      const deps: EngineDeps = {
        config: makeConfig(),
        adapter: FAKE_ADAPTER,
        complete,
        cwd: dir,
        onEvent: () => {},
        onUsage: () => {},
      }

      const engine = createEngine(deps)
      const result = await engine({ rootPrompt: 'load my files', context: [], depth: 0 })

      // Two files were packed by the host and appended into the sandbox `context`.
      expect(result.answer).toBe('2')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
