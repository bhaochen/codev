import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStore } from '../store.js'
import type { WorkflowSnapshot } from '../types.js'
import { resetWorkflowRuntimeForTests, WorkflowRuntime } from '../runtime.js'

type Enqueued = { value: string; mode: string }

async function writeWf(root: string, stem: string, code: string): Promise<void> {
  const dir = join(root, '.claude', 'workflows')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${stem}.workflow.ts`), code)
}

function snap(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    status: 'running',
    currentNode: 'a',
    activeNode: null,
    stepCount: 0,
    attempts: {},
    outputs: {},
    error: null,
    lastError: null,
    input: {},
    ...overrides,
  }
}

async function makeRuntime(opts: {
  fixtures?: Array<{ stem: string; code: string }>
  execShell?: (command: string, timeoutMs: number) => Promise<string>
} = {}) {
  const project = await mkdtemp(join(tmpdir(), 'codev-wf-rt-'))
  const dbDir = await mkdtemp(join(tmpdir(), 'codev-wf-db-'))
  const queued: Enqueued[] = []
  for (const fx of opts.fixtures ?? []) await writeWf(project, fx.stem, fx.code)
  const runtime = new WorkflowRuntime({
    cwd: () => project,
    sessionId: () => 'sess-test',
    storePath: () => join(dbDir, 'state.sqlite'),
    enqueueCommand: (value, mode) => queued.push({ value, mode }),
    execShell: opts.execShell ?? (async () => 'ok'),
  })
  return {
    runtime,
    queued,
    project,
    dbDir,
    dbPath: join(dbDir, 'state.sqlite'),
    cleanup: async () => {
      await rm(project, { recursive: true, force: true })
      await rm(dbDir, { recursive: true, force: true })
    },
  }
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const COMPUTE_PIPELINE = `export default {
  name: 'pipe',
  startAt: 'one',
  nodes: {
    one: { kind: 'compute', run: ({ input }) => 'one:' + String(input.task) },
    two: { kind: 'compute', run: ({ outputs }) => 'two:' + String(outputs.one) },
  },
  edges: [{ from: 'one', to: 'two' }],
}`

describe('WorkflowRuntime', () => {
  test('runs a compute-only workflow to completion and persists everything', async () => {
    const h = await makeRuntime({ fixtures: [{ stem: 'pipe', code: COMPUTE_PIPELINE }] })
    try {
      const msg = await h.runtime.start('pipe', { task: 'x' })
      expect(msg).toContain('started')
      await until(() => h.runtime.getStatus()?.status === 'completed')
      const status = h.runtime.getStatus()!
      expect(status.stepCount).toBe(2)
      // notifications: started + completed
      expect(h.queued.filter(q => q.mode === 'task-notification')).toHaveLength(2)

      const store = WorkflowStore.open(h.dbPath)
      const record = store.listRuns({ sessionId: 'sess-test' })[0]!
      expect(record.status).toBe('completed')
      expect(record.snapshot.outputs.two).toBe('two:one:x')
      const types = store.events(record.id).map(e => e.type)
      expect(types).toContain('run_started')
      expect(types).toContain('node_completed')
      expect(types).toContain('run_completed')
    } finally {
      await h.cleanup()
    }
  })

  test('agent steps enqueue prompts and submit advances the run', async () => {
    const h = await makeRuntime({
      fixtures: [{
        stem: 'ag',
        code: `export default {
          name: 'ag',
          startAt: 'ask',
          nodes: {
            ask: { kind: 'agent', prompt: ({ input }) => 'about ' + String(input.task) },
            done: { kind: 'compute', run: () => 'fin' },
          },
          edges: [{ from: 'ask', to: 'done' }],
        }`,
      }],
    })
    try {
      await h.runtime.start('ag', { task: 'life' })
      await until(() => h.queued.some(q => q.mode === 'prompt'))
      const step = h.queued.find(q => q.mode === 'prompt')!
      expect(step.value).toContain('<workflow-step>')
      expect(step.value).toContain('node: ask')
      expect(step.value).toContain('about life')

      const rejected = h.runtime.handleSubmit('unused') // wrong shape ok for agent
      expect(rejected.ok).toBe(true)
      await until(() => h.runtime.getStatus()?.status === 'completed')
    } finally {
      await h.cleanup()
    }
  })

  test('decision rejection consumes an attempt and reports retry', async () => {
    const h = await makeRuntime({
      fixtures: [{
        stem: 'dec',
        code: `export default {
          name: 'dec',
          startAt: 'pick',
          nodes: {
            pick: { kind: 'decision', prompt: () => 'p', choices: ['yes'] },
            end: { kind: 'compute', run: () => 'e' },
          },
          edges: [{ from: 'pick', case: { yes: 'end' } }],
        }`,
      }],
    })
    try {
      await h.runtime.start('dec', {})
      await until(() => h.queued.some(q => q.mode === 'prompt'))
      const bad = h.runtime.handleSubmit({ choice: 'nope' })
      expect(bad.ok).toBe(false)
      expect(bad.message).toContain('Rejected')
      const good = h.runtime.handleSubmit({ choice: 'yes' })
      expect(good.ok).toBe(true)
      await until(() => h.runtime.getStatus()?.status === 'completed')
      expect(h.runtime.getStatus()!.attempts.pick).toBe(2)
    } finally {
      await h.cleanup()
    }
  })

  test('checkpoint parks the run and answer continues it', async () => {
    const h = await makeRuntime({
      fixtures: [{
        stem: 'gate',
        code: `export default {
          name: 'gate',
          startAt: 'pre',
          nodes: {
            pre: { kind: 'compute', run: () => 'plan' },
            gate: { kind: 'checkpoint', message: () => 'approve?' },
            post: { kind: 'compute', run: ({ outputs }) => 'post:' + String((outputs.gate as any).approved) },
          },
          edges: [{ from: 'pre', to: 'gate' }, { from: 'gate', to: 'post' }],
        }`,
      }],
    })
    try {
      await h.runtime.start('gate', {})
      await until(() => h.runtime.getStatus()?.status === 'waiting')
      expect(h.runtime.getStatus()!.activeNode).toBe('gate')
      expect(h.queued.some(q => q.value.includes('/workflows answer'))).toBe(true)

      const out = h.runtime.answer({ approved: true })
      expect(out).toContain('continuing')
      await until(() => h.runtime.getStatus()?.status === 'completed')
    } finally {
      await h.cleanup()
    }
  })

  test('pause takes effect at the step boundary; resume re-enqueues', async () => {
    const h = await makeRuntime({
      fixtures: [{
        stem: 'twostep',
        code: `export default {
          name: 'twostep',
          startAt: 'a',
          nodes: {
            a: { kind: 'agent', prompt: () => 'first' },
            b: { kind: 'agent', prompt: () => 'second' },
          },
          edges: [{ from: 'a', to: 'b' }],
        }`,
      }],
    })
    try {
      await h.runtime.start('twostep', {})
      await until(() => h.queued.length >= 1)
      expect(h.runtime.requestPause()).toContain('finishes first')

      const first = h.runtime.handleSubmit('A')
      expect(first.ok).toBe(true)
      await until(() => h.runtime.getStatus()?.status === 'paused')
      const promptsAfterPause = h.queued.filter(q => q.mode === 'prompt').length

      h.runtime.resume()
      await until(() => h.queued.filter(q => q.mode === 'prompt').length > promptsAfterPause)
      const second = h.queued[h.queued.length - 1]!
      expect(second.value).toContain('second')
    } finally {
      await h.cleanup()
    }
  })

  test('cancel from waiting clears the run', async () => {
    const h = await makeRuntime({
      fixtures: [{
        stem: 'c',
        code: `export default {
          name: 'c',
          startAt: 'g',
          nodes: { g: { kind: 'checkpoint', message: () => 'hold' } },
          edges: [],
        }`,
      }],
    })
    try {
      await h.runtime.start('c', {})
      await until(() => h.runtime.getStatus()?.status === 'waiting')
      expect(h.runtime.cancel()).toContain('Cancelled')
      expect(h.runtime.getStatus()?.status).toBe('cancelled')
      expect(h.runtime.cancel()).toContain('No active')
    } finally {
      await h.cleanup()
    }
  })

  test('shell failures fail the run when retries are exhausted', async () => {
    const h = await makeRuntime({
      execShell: async () => {
        throw new Error('boom')
      },
      fixtures: [{
        stem: 'sh',
        code: `export default {
          name: 'sh',
          startAt: 's',
          nodes: { s: { kind: 'shell', exec: 'false' } },
          edges: [],
        }`,
      }],
    })
    try {
      await h.runtime.start('sh', {})
      await until(() => h.runtime.getStatus()?.status === 'failed')
      expect(h.runtime.getStatus()!.error).toContain('boom')
    } finally {
      await h.cleanup()
    }
  })


  test('recover claims a parked run of the same session', async () => {
    const h = await makeRuntime({ fixtures: [{ stem: 'pipe', code: COMPUTE_PIPELINE }] })
    try {
      const source = join(h.project, '.claude', 'workflows', 'pipe.workflow.ts')
      const store = WorkflowStore.open(h.dbPath)
      store.createRun({
        workflowName: 'pipe',
        sourcePath: source,
        sessionId: 'sess-test',
        input: { task: 'resume-me' },
        snapshot: snap({ currentNode: 'one', input: { task: 'resume-me' } }),
      })
      store.close()

      // A fresh runtime instance simulates the reopened conversation.
      const queued2 = []
      const runtime2 = new WorkflowRuntime({
        cwd: () => h.project,
        sessionId: () => 'sess-test',
        storePath: () => h.dbPath,
        enqueueCommand: (value, mode) => queued2.push({ value, mode }),
        execShell: async () => 'ok',
      })
      const recovered = await runtime2.recover()
      expect(recovered).not.toBe('')
      await until(() => runtime2.getStatus()?.status === 'completed')
      // The run was parked at "one" with empty outputs; it re-ran both nodes.
      const reopened = WorkflowStore.open(h.dbPath)
      const record = reopened.listRuns({ sessionId: 'sess-test' })[0]!
      expect(record.snapshot.outputs.two).toBe('two:one:resume-me')
      reopened.close()
    } finally {
      resetWorkflowRuntimeForTests()
      await h.cleanup()
    }
  })

  test('recover ignores other sessions and does nothing without candidates', async () => {
    const h = await makeRuntime({
      fixtures: [{ stem: 'pipe', code: COMPUTE_PIPELINE }],
    })
    try {
      const source = join(h.project, '.claude', 'workflows', 'pipe.workflow.ts')
      const store = WorkflowStore.open(h.dbPath)
      store.createRun({
        workflowName: 'pipe',
        sourcePath: source,
        sessionId: 'someone-else',
        input: {},
        snapshot: snap(),
      })
      store.close()
      const recovered = await h.runtime.recover()
      expect(recovered).toBe('')
      expect(h.runtime.getStatus()).toBeNull()
    } finally {
      await h.cleanup()
    }
  })
})

