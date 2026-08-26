import { describe, expect, test } from 'bun:test'
import {
  agent,
  compute,
  checkpoint,
  decision,
  defineWorkflow,
  notify,
  shell,
} from '../definition.js'
import { WorkflowEngine, WorkflowEngineError } from '../engine.js'
import { routeKeyOf, WorkflowGraphError } from '../graph.js'
import type { NormalizedWorkflow } from '../types.js'

/** Drive a compute-only workflow to completion, returning the snapshot. */
function runThrough(def: NormalizedWorkflow, input: Record<string, unknown> = {}) {
  const engine = new WorkflowEngine(def, input)
  for (;;) {
    const action = engine.peek()
    if (action.type === 'stop') return { engine, final: action.reason }
    if (action.type === 'execute') {
      engine.beginNode()
      const def0 = def.nodes[action.node]
      const output =
        def0.kind === 'compute'
          ? def0.run({ input, outputs: engine.snapshot.outputs })
          : `raw:${action.node}`
      engine.completeNode(output)
    }
  }
}

describe('definition', () => {
  test('normalizes defaults and accepts a valid graph', () => {
    const wf = defineWorkflow({
      name: 'echo',
      startAt: 'reply',
      nodes: { reply: agent({ prompt: () => 'hi' }) },
      edges: [],
    })
    expect(wf.maxSteps).toBe(100)
  })

  test('rejects unknown startAt', () => {
    expect(() =>
      defineWorkflow({
        name: 'bad',
        startAt: 'nope',
        nodes: { a: compute({ run: () => 1 }) },
        edges: [],
      }),
    ).toThrow('startAt')
  })

  test('rejects edges referencing unknown nodes and duplicate outgoing edges', () => {
    expect(() =>
      defineWorkflow({
        name: 'bad',
        startAt: 'a',
        nodes: { a: compute({ run: () => 1 }) },
        edges: [{ from: 'a', to: 'ghost' }],
      }),
    ).toThrow('unknown target node')

    expect(() =>
      defineWorkflow({
        name: 'bad',
        startAt: 'a',
        nodes: {
          a: compute({ run: () => 1 }),
          b: compute({ run: () => 2 }),
          c: compute({ run: () => 3 }),
        },
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' },
        ],
      }),
    ).toThrow('at most one is allowed')
  })

  test('all six node constructors produce typed defs', () => {
    const wf = defineWorkflow({
      name: 'kitchen-sink',
      startAt: 'n',
      nodes: {
        n: compute({ run: () => 1 }),
        a: agent({ prompt: () => 'p' }),
        s: shell({ exec: 'echo hi' }),
        nt: notify({ message: 'done' }),
        c: checkpoint({ message: 'ok?' }),
        d: decision({ prompt: () => 'pick', choices: ['x', 'y'] }),
      },
      edges: [],
    })
    expect(Object.keys(wf.nodes)).toHaveLength(6)
  })
})

describe('graph routing', () => {
  test('routeKeyOf prefers route then choice, falls back to primitives', () => {
    expect(routeKeyOf('clean')).toBe('clean')
    expect(routeKeyOf(42)).toBe('42')
    expect(routeKeyOf({ route: 'a', choice: 'b' })).toBe('a')
    expect(routeKeyOf({ choice: 'b' })).toBe('b')
    expect(routeKeyOf({ other: true })).toBeUndefined()
    expect(routeKeyOf(null)).toBeUndefined()
  })

  test('missing switch case without default fails the run via WorkflowGraphError', () => {
    const wf = defineWorkflow({
      name: 'switchy',
      startAt: 'start',
      nodes: {
        start: compute({ run: () => 'unknown-key' }),
        fallback: compute({ run: () => 'fb' }),
      },
      edges: [{ from: 'start', case: { known: 'fallback' } }],
    })
    const { engine, final } = runThrough(wf)
    expect(final).toBe('failed')
    expect(engine.snapshot.error).toContain('no route from "start"')
  })

  test('terminal node (no outgoing edge) completes the run', () => {
    const wf = defineWorkflow({
      name: 'linear',
      startAt: 'one',
      nodes: {
        one: compute({ run: () => 1 }),
        two: compute({ run: ({ outputs }) => (outputs.one as number) + 1 }),
      },
      edges: [{ from: 'one', to: 'two' }],
    })
    const { engine, final } = runThrough(wf)
    expect(final).toBe('completed')
    expect(engine.snapshot.outputs).toEqual({ one: 1, two: 2 })
    expect(engine.snapshot.stepCount).toBe(2)
  })
})

describe('engine decisions and branches', () => {
  function branchWf() {
    return defineWorkflow({
      name: 'branch',
      startAt: 'classify',
      nodes: {
        classify: decision({
          prompt: ({ input }) => `classify ${String(input.task)}`,
          choices: ['continue', 'clarify'],
        }),
        work: compute({ run: () => 'working' }),
        ask: compute({ run: () => 'asking' }),
      },
      edges: [
        { from: 'classify', case: { continue: 'work', clarify: 'ask' }, default: 'ask' },
      ],
    })
  }

  test('routes on the chosen case', () => {
    const wf = branchWf()
    const engine = new WorkflowEngine(wf, { task: 'x' })
    engine.beginNode()
    engine.completeNode({ choice: 'continue' })
    expect(engine.peek()).toEqual({ type: 'execute', node: 'work' })
    engine.beginNode()
    engine.completeNode('working')
    expect(engine.status).toBe('completed')
  })

  test('falls back to default for a valid choice missing from the case map', () => {
    const wf = defineWorkflow({
      name: 'branch-default',
      startAt: 'classify',
      nodes: {
        classify: decision({ prompt: () => 'pick', choices: ['continue', 'clarify'] }),
        work: compute({ run: () => 'working' }),
        ask: compute({ run: () => 'asking' }),
      },
      edges: [{ from: 'classify', case: { continue: 'work' }, default: 'ask' }],
    })
    const engine = new WorkflowEngine(wf, {})
    engine.beginNode()
    engine.completeNode({ choice: 'clarify' })
    expect(engine.peek()).toEqual({ type: 'execute', node: 'ask' })
  })

  test('invalid decision output consumes an attempt, then fails terminally', () => {
    const wf = defineWorkflow({
      name: 'strict',
      startAt: 'd',
      nodes: {
        d: decision({ prompt: () => 'pick', choices: ['yes'], maxAttempts: 2 }),
        end: compute({ run: () => 'e' }),
      },
      edges: [{ from: 'd', case: { yes: 'end' } }],
    })
    const engine = new WorkflowEngine(wf, {})
    engine.beginNode()
    engine.completeNode({ nope: 1 })
    expect(engine.status).toBe('running')
    expect(engine.snapshot.lastError).toContain('expected one of')
    // retry also invalid -> budget of 2 exhausted
    engine.beginNode()
    engine.completeNode('still-bad')
    expect(engine.status).toBe('failed')
    expect(engine.snapshot.error).toContain('after 2 attempt(s)')
  })

  test('valid retry after a failed attempt re-runs the same node', () => {
    const wf = defineWorkflow({
      name: 'flaky',
      startAt: 'a',
      nodes: { a: agent({ prompt: () => 'p', maxAttempts: 3 }), b: compute({ run: () => 'b' }) },
      edges: [{ from: 'a', to: 'b' }],
    })
    const engine = new WorkflowEngine(wf, {})
    engine.beginNode()
    engine.failNode('transient error')
    expect(engine.status).toBe('running')
    engine.beginNode()
    expect(engine.snapshot.attempts.a).toBe(2)
    engine.completeNode('ok')
    expect(engine.peek()).toEqual({ type: 'execute', node: 'b' })
  })

  test('failNode beyond budget fails the run with attempt count', () => {
    const wf = defineWorkflow({
      name: 'hopeless',
      startAt: 'a',
      nodes: { a: compute({ run: () => 1 }) },
      edges: [],
    })
    const engine = new WorkflowEngine(wf, {})
    engine.beginNode()
    engine.failNode('boom')
    expect(engine.status).toBe('failed')
    expect(engine.snapshot.error).toContain('after 1 attempt(s)')
  })
})

describe('engine loops and budgets', () => {
  test('cycles run until maxSteps is exceeded', () => {
    const wf = defineWorkflow({
      name: 'loop',
      startAt: 'tick',
      maxSteps: 5,
      nodes: { tick: compute({ run: () => 'again' }) },
      edges: [{ from: 'tick', to: 'tick' }],
    })
    const { engine, final } = runThrough(wf)
    expect(final).toBe('failed')
    expect(engine.snapshot.error).toBe('exceeded maxSteps (5)')
    expect(engine.snapshot.stepCount).toBe(5)
  })
})

describe('engine checkpoints', () => {
  test('checkpoint parks in waiting until answered', () => {
    const wf = defineWorkflow({
      name: 'gate',
      startAt: 'prepare',
      nodes: {
        prepare: compute({ run: () => 'plan' }),
        gate: checkpoint({ message: ({ outputs }) => `approve ${String(outputs.prepare)}?` }),
        finish: compute({ run: ({ outputs }) => `done:${String((outputs.gate as { approved: boolean }).approved)}` }),
      },
      edges: [{ from: 'prepare', to: 'gate' }, { from: 'gate', to: 'finish' }],
    })
    const engine = new WorkflowEngine(wf, {})
    engine.beginNode()
    engine.completeNode('plan')
    expect(engine.peek()).toEqual({ type: 'execute', node: 'gate' })

    engine.beginNode()
    expect(engine.status).toBe('waiting')
    engine.answer({ approved: true })
    expect(engine.peek()).toEqual({ type: 'execute', node: 'finish' })
    engine.beginNode()
    engine.completeNode('done:true')
    expect(engine.status).toBe('completed')
  })

  test('answer on a non-checkpoint throws', () => {
    const wf = defineWorkflow({
      name: 'plain',
      startAt: 'a',
      nodes: { a: compute({ run: () => 1 }) },
      edges: [],
    })
    const engine = new WorkflowEngine(wf, {})
    engine.beginNode()
    expect(() => engine.answer('x')).toThrow(WorkflowEngineError)
  })
})

describe('engine pause, resume, cancel, snapshot', () => {
  function twoStep() {
    return defineWorkflow({
      name: 'two',
      startAt: 'a',
      nodes: {
        a: compute({ run: () => 'A' }),
        b: compute({ run: () => 'B' }),
      },
      edges: [{ from: 'a', to: 'b' }],
    })
  }

  test('requestPause holds before the next node; resume continues', () => {
    const wf = twoStep()
    const engine = new WorkflowEngine(wf, {})
    engine.beginNode()
    engine.requestPause()
    engine.completeNode('A')
    expect(engine.status).toBe('paused')
    expect(engine.peek()).toEqual({ type: 'stop', reason: 'paused' })
    engine.resume()
    expect(engine.peek()).toEqual({ type: 'execute', node: 'b' })
    engine.beginNode()
    engine.completeNode('B')
    expect(engine.status).toBe('completed')
  })

  test('cancel works mid-run and is idempotent when terminal', () => {
    const wf = twoStep()
    const engine = new WorkflowEngine(wf, {})
    engine.beginNode()
    engine.cancel()
    expect(engine.status).toBe('cancelled')
    expect(() => engine.beginNode()).toThrow(WorkflowEngineError)
    engine.cancel()
    expect(engine.status).toBe('cancelled')
  })

  test('snapshot roundtrip restores an interrupted run', () => {
    const wf = twoStep()
    const engine = new WorkflowEngine(wf, { k: 'v' })
    engine.beginNode()
    engine.completeNode('A')
    const snap = JSON.parse(JSON.stringify(engine.snapshot))

    const restored = WorkflowEngine.fromSnapshot(wf, snap)
    expect(restored.peek()).toEqual({ type: 'execute', node: 'b' })
    expect(restored.snapshot.input).toEqual({ k: 'v' })
    restored.beginNode()
    restored.completeNode('B')
    expect(restored.status).toBe('completed')
    expect(restored.snapshot.outputs).toEqual({ a: 'A', b: 'B' })
  })

  test('peek throws defensively on corrupt state', () => {
    const wf = twoStep()
    const engine = WorkflowEngine.fromSnapshot(wf, {
      status: 'running',
      currentNode: null,
      activeNode: null,
      stepCount: 0,
      attempts: {},
      outputs: {},
      error: null,
      lastError: null,
      input: {},
    })
    expect(() => engine.peek()).toThrow(WorkflowEngineError)
  })
})
