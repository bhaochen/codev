import { maxAttemptsFor } from './definition.js'
import { resolveNext, routeKeyOf, WorkflowGraphError } from './graph.js'
import type {
  EngineAction,
  NormalizedWorkflow,
  RunStatus,
  WorkflowNodeDef,
  WorkflowSnapshot,
} from './types.js'

/** Thrown when an engine method is called outside its valid state. */
export class WorkflowEngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowEngineError'
  }
}

function initialState(input: Record<string, unknown>): WorkflowSnapshot {
  return {
    status: 'running',
    currentNode: null,
    activeNode: null,
    stepCount: 0,
    attempts: {},
    outputs: {},
    error: null,
    lastError: null,
    input,
  }
}

function cloneSnapshot(snap: WorkflowSnapshot): WorkflowSnapshot {
  return {
    ...snap,
    attempts: { ...snap.attempts },
    outputs: structuredClone(snap.outputs),
  }
}

/**
 * Pure per-run state machine: routes node completions through the graph,
 * tracks attempts and step budget, and exposes the action an executor
 * should take next. Knows nothing about sessions, prompts, or I/O — the
 * session-side executor drives it via peek/beginNode/completeNode/failNode.
 */
export class WorkflowEngine {
  private readonly def: NormalizedWorkflow
  private state: WorkflowSnapshot
  private pauseRequested = false

  constructor(def: NormalizedWorkflow, input: Record<string, unknown>) {
    this.def = def
    this.state = initialState(input)
    this.state.currentNode = def.startAt
  }

  static fromSnapshot(def: NormalizedWorkflow, snap: WorkflowSnapshot): WorkflowEngine {
    const engine = new WorkflowEngine(def, snap.input)
    engine.state = cloneSnapshot(snap)
    return engine
  }

  get status(): RunStatus {
    return this.state.status
  }

  get snapshot(): WorkflowSnapshot {
    return cloneSnapshot(this.state)
  }

  /**
   * What the executor should do right now, computed without mutating state.
   * Idempotent — safe to poll.
   */
  peek(): EngineAction {
    switch (this.state.status) {
      case 'paused':
      case 'completed':
      case 'failed':
      case 'cancelled':
        return { type: 'stop', reason: this.state.status }
      case 'waiting':
      case 'running':
        break
    }
    if (this.state.activeNode !== null) {
      return { type: 'await_result', node: this.state.activeNode }
    }
    if (this.state.currentNode === null) {
      throw new WorkflowEngineError('run has no current node but is not finished')
    }
    return { type: 'execute', node: this.state.currentNode }
  }

  /**
   * Mark the current node as executing. Returns its definition so the
   * executor can dispatch by kind. Increments the attempt counter.
   */
  beginNode(): { node: string; def: WorkflowNodeDef } {
    const { currentNode, activeNode, status } = this.state
    if (this.isTerminal()) {
      throw new WorkflowEngineError(`cannot begin a node on a ${status} run`)
    }
    if (status === 'paused') {
      throw new WorkflowEngineError('cannot begin a node while paused')
    }
    if (activeNode !== null) {
      throw new WorkflowEngineError(`node "${activeNode}" is still active`)
    }
    if (currentNode === null) {
      throw new WorkflowEngineError('no node to begin')
    }
    this.state.attempts[currentNode] = (this.state.attempts[currentNode] ?? 0) + 1
    this.state.activeNode = currentNode
    this.state.lastError = null
    if (this.def.nodes[currentNode].kind === 'checkpoint') {
      this.state.status = 'waiting'
    }
    return { node: currentNode, def: this.def.nodes[currentNode] }
  }

  /** Finish the active node successfully and advance through the graph. */
  completeNode(output: unknown): void {
    const finished = this.requireActiveNode()
    if (!this.validateDecisionOutput(finished, output)) return

    this.state.outputs[finished] = output
    this.state.activeNode = null
    this.state.stepCount++

    let next: string | null
    try {
      next = resolveNext(this.def, finished, output)
    } catch (error) {
      if (error instanceof WorkflowGraphError) {
        this.state.status = 'failed'
        this.state.error = error.message
        return
      }
      throw error
    }

    if (next === null) {
      this.state.currentNode = null
      this.state.status = 'completed'
      return
    }

    if (this.state.stepCount >= this.def.maxSteps) {
      this.state.currentNode = next
      this.state.status = 'failed'
      this.state.error = `exceeded maxSteps (${this.def.maxSteps})`
      return
    }

    this.state.currentNode = next
    this.state.status = this.pauseRequested ? 'paused' : 'running'
    this.pauseRequested = false
  }

  /**
   * Fail the active node. Retries while the attempt budget lasts (the same
   * node stays current); otherwise the run fails terminally.
   */
  failNode(message: string): void {
    const node = this.requireActiveNode()
    this.state.activeNode = null
    const budget = maxAttemptsFor(this.def.nodes[node])
    if ((this.state.attempts[node] ?? 0) < budget) {
      this.state.lastError = message
      this.state.status = 'running'
      return
    }
    this.state.status = 'failed'
    this.state.error = `node "${node}" failed after ${this.state.attempts[node]} attempt(s): ${message}`
  }

  /** Hold the run before the next node starts (current step finishes first). */
  requestPause(): void {
    if (this.isTerminal()) return
    this.pauseRequested = true
    if (this.state.activeNode === null && this.state.currentNode !== null) {
      this.state.status = 'paused'
    }
  }

  resume(): void {
    if (this.state.status !== 'paused') {
      throw new WorkflowEngineError(`cannot resume from status "${this.state.status}"`)
    }
    if (this.state.currentNode === null) {
      throw new WorkflowEngineError('nothing to resume')
    }
    this.state.status = 'running'
  }

  /** Answer a parked checkpoint; the answer becomes the node output. */
  answer(value: unknown): void {
    const node = this.requireActiveNode()
    if (this.def.nodes[node].kind !== 'checkpoint') {
      throw new WorkflowEngineError(`node "${node}" is not a checkpoint`)
    }
    this.completeNode(value)
  }

  cancel(): void {
    if (this.isTerminal()) return
    this.state.activeNode = null
    this.state.status = 'cancelled'
  }

  private requireActiveNode(): string {
    const { activeNode, status } = this.state
    if (this.isTerminal()) {
      throw new WorkflowEngineError(`run is ${status}`)
    }
    if (status === 'paused') {
      throw new WorkflowEngineError('run is paused')
    }
    if (activeNode === null) {
      throw new WorkflowEngineError('no active node')
    }
    return activeNode
  }

  private validateDecisionOutput(node: string, output: unknown): boolean {
    const def = this.def.nodes[node]
    if (def.kind !== 'decision') return true
    const key = routeKeyOf(output)
    if (key !== undefined && def.choices.includes(key)) return true
    // Invalid answers consume the attempt budget like any other failure.
    this.state.lastError =
      `decision "${node}" expected one of [${def.choices.join(', ')}], got ${JSON.stringify(output)}`
    this.failNode(this.state.lastError)
    return false
  }

  private isTerminal(): boolean {
    return (
      this.state.status === 'completed' ||
      this.state.status === 'failed' ||
      this.state.status === 'cancelled'
    )
  }
}
