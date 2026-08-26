import { exec } from 'node:child_process'
import { getSessionId } from '../bootstrap/state.js'
import { enqueue, removeByFilter } from '../utils/messageQueueManager.js'
import { WorkflowEngine } from './engine.js'
import { discoverWorkflows, loadWorkflow } from './loader.js'
import { ACTIVE_STATUSES, WorkflowStore, type RunRecord } from './store.js'
import type {
  NormalizedWorkflow,
  RunStatus,
  WorkflowNodeDef,
} from './types.js'

/** Injectable dependencies — tests swap every I/O seam. */
export type RuntimeDeps = {
  storePath?: () => string
  sessionId?: () => string
  enqueueCommand?: (value: string, mode: 'prompt' | 'task-notification') => void
  execShell?: (
    command: string,
    timeoutMs: number,
  ) => Promise<string>
  cwd?: () => string
  /** Fired on every persisted transition — used by the task-panel bridge. */
  onTransition?: (line: RuntimeStatusLine) => void
}

type ActiveRun = {
  runId: string
  workflow: NormalizedWorkflow
  engine: WorkflowEngine
}

export type RuntimeStatusLine = {
  runId: string
  name: string
  status: RunStatus
  currentNode: string | null
  activeNode: string | null
  stepCount: number
  attempts: Record<string, number>
  lastError: string | null
  error: string | null
}

const DEFAULT_SHELL_TIMEOUT_MS = 60_000

function defaultExecShell(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed
            ? `timed out after ${timeoutMs}ms`
            : stderr.trim() || error.message
          reject(new Error(reason))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * Session-side workflow executor. Owns the one active run slot of this
 * conversation, drives local node kinds inline, hands agent/decision steps
 * to the model by enqueuing step prompts, and persists every transition.
 */
export class WorkflowRuntime {
  private readonly deps: Required<Pick<RuntimeDeps, 'sessionId'>> & RuntimeDeps
  private readonly storePromise: Promise<WorkflowStore>
  private active: ActiveRun | null = null
  private advancing = false

  constructor(deps: RuntimeDeps = {}) {
    this.deps = {
      sessionId: deps.sessionId ?? (() => getSessionId()),
      ...deps,
    }
    this.storePromise = Promise.resolve().then(() => {
      const store = WorkflowStore.open(deps.storePath?.())
      // A crashed session leaves runs marked running behind; park them so
      // recover() can claim them instead of the store looking mid-flight.
      for (const run of store.listRuns({ statuses: ['running'] })) {
        if (!run.ownerLease) continue
        store.setOwnerLease(run.id, null)
      }
      return store
    })
  }

  private async store(): Promise<WorkflowStore> {
    return this.storePromise
  }

  /** Current run summary for /workflows status and the widget. */
  getStatus(): RuntimeStatusLine | null {
    const active = this.active
    if (!active) return null
    const snap = active.engine.snapshot
    return {
      runId: active.runId,
      name: active.workflow.name,
      status: snap.status,
      currentNode: snap.currentNode,
      activeNode: snap.activeNode,
      stepCount: snap.stepCount,
      attempts: snap.attempts,
      lastError: snap.lastError,
      error: snap.error,
    }
  }

  async listStoredRuns(filter: { statuses?: readonly RunStatus[] } = {}): Promise<RunRecord[]> {
    return (await this.store()).listRuns({
      sessionId: this.deps.sessionId(),
      statuses: filter.statuses,
    })
  }

  async start(name: string, input: Record<string, unknown> = {}): Promise<string> {
    const current = this.getStatus()
    if (current && ACTIVE_STATUSES.includes(current.status)) {
      return `A workflow is already active in this session: "${current.name}" (${current.runId}). Cancel it first with /workflows cancel.`
    }
    const cwd = this.deps.cwd?.()
    const discovered = await discoverWorkflows(cwd ? { cwd } : {})
    const entry = discovered.workflows.find(wf => wf.name === name)
    if (!entry) {
      const known = discovered.workflows.map(wf => wf.name).join(', ')
      throw new Error(known ? `Unknown workflow "${name}". Available: ${known}` : `No workflows found. Put *.workflow.ts files in .claude/workflows/ or ~/.claude/workflows/.`)
    }
    const workflow = await loadWorkflow(entry.path)

    const engine = new WorkflowEngine(workflow, input)
    const store = await this.store()
    const runId = store.createRun({
      workflowName: workflow.name,
      sourcePath: entry.path,
      sessionId: this.deps.sessionId(),
      input,
      snapshot: engine.snapshot,
    })
    this.active = { runId, workflow, engine }
    store.appendEvent(runId, 'run_started', { name: workflow.name, input })
    this.notify(`Workflow "${name}" started (${runId})`)
    void this.advance()
    return `Workflow "${name}" started (${runId})`
  }

  requestPause(): string {
    const active = this.requireActive()
    active.engine.requestPause()
    void this.persist('paused_requested')
    return active.engine.status === 'paused'
      ? `Paused before next node (${active.runId}). Resume with /workflows resume.`
      : `Pause requested — the current step finishes first, then the run holds (${active.runId}).`
  }

  resume(): string {
    const active = this.requireActive()
    active.engine.resume()
    void this.persist('resumed')
    void this.advance()
    return `Resumed ${active.runId} at node "${active.engine.snapshot.currentNode ?? '?'}"`
  }

  cancel(): string {
    const active = this.active
    if (!active || active.engine.peek().type === 'stop') {
      return 'No active workflow in this session.'
    }
    active.engine.cancel()
    void this.persist('cancelled')
    this.notify(`Workflow "${active.workflow.name}" cancelled (${active.runId})`)
    // Drop any step prompts still queued for this run.
    void removeByFilter(
      cmd =>
        typeof cmd.value === 'string' &&
        cmd.value.includes(`<!--wf:${active.runId}-->`),
    )
    return `Cancelled ${active.runId}`
  }

  /** Answer a parked checkpoint. Accepts any JSON value. */
  answer(value: unknown): string {
    const active = this.requireActive()
    active.engine.answer(value)
    void this.persist('checkpoint_answered')
    void this.advance()
    return `Answer accepted — continuing at node "${active.engine.snapshot.currentNode ?? '?'}"`
  }

  /**
   * Model delivered structured output for the active step. Called from the
   * Workflow tool mid-turn; advances the state machine immediately and lets
   * the queued-loop pick up the next step once the turn settles.
   */
  handleSubmit(output: unknown): { ok: boolean; message: string } {
    const active = this.active
    if (!active) {
      return { ok: false, message: 'No workflow is running in this session.' }
    }
    const action = active.engine.peek()
    let pendingNode: string | null = null
    if (action.type === 'await_result') {
      pendingNode = action.node
    } else if (action.type === 'execute') {
      // A previous decision submission may have been rejected — allow an
      // immediate retry against the same still-current node.
      const retryKind = active.workflow.nodes[action.node]?.kind
      if (retryKind === 'agent' || retryKind === 'decision') pendingNode = action.node
    }
    if (pendingNode === null) {
      return {
        ok: false,
        message: `Workflow "${active.workflow.name}" is not waiting for output (status: ${active.engine.status}).`,
      }
    }
    const nodeDef = active.workflow.nodes[pendingNode]
    if (nodeDef.kind !== 'agent' && nodeDef.kind !== 'decision') {
      return {
        ok: false,
        message: `Node "${pendingNode}" does not accept submissions.`,
      }
    }
    if (action.type === 'execute') active.engine.beginNode()
    const beforeError = active.engine.snapshot.lastError
    try {
      active.engine.completeNode(output)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    const after = active.engine.snapshot
    if (after.status === 'failed') {
      this.notify(`Workflow "${active.workflow.name}" failed: ${after.error}`)
      return { ok: false, message: `Step failed permanently: ${after.error}` }
    }
    if (
      after.status === 'running' &&
      after.activeNode === null &&
      after.currentNode === pendingNode &&
      after.lastError &&
      after.lastError !== beforeError
    ) {
      // Decision rejected the value; the attempt was consumed — retry.
      return { ok: false, message: `Rejected: ${after.lastError}` }
    }
    void this.persist('step_submitted', { node: pendingNode })
    // Defer so the tool result lands before the next step prompt is queued.
    setTimeout(() => void this.advance(), 0)
    return {
      ok: true,
      message: `Output recorded for "${pendingNode}".`,
    }
  }

  /**
   * Re-claim the newest parked run belonging to this session (e.g. after a
   * restart). Runs bound to other sessions are never touched.
   */
  async recover(): Promise<string> {
    const store = await this.store()
    const sessionId = this.deps.sessionId()
    const candidates = store.listRuns({ sessionId, statuses: ACTIVE_STATUSES })
    const record = candidates[0]
    if (!record) return ''
    if (this.getStatus()) {
      return '' // something already active; do not preempt
    }
    if (!record.sourcePath) {
      store.updateRun(record.id, { ...record.snapshot, status: 'failed' })
      return ''
    }
    let workflow: NormalizedWorkflow
    try {
      workflow = await loadWorkflow(record.sourcePath)
    } catch (error) {
      store.updateRun(record.id, {
        ...record.snapshot,
        status: 'failed',
        error: `source no longer loads: ${error instanceof Error ? error.message : String(error)}`,
      })
      return ''
    }
    this.active = {
      runId: record.id,
      workflow,
      engine: WorkflowEngine.fromSnapshot(workflow, record.snapshot),
    }
    this.notify(`Resumed workflow "${record.workflowName}" (${record.id})`)
    void this.advance()
    return record.id
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireActive(): ActiveRun {
    if (!this.active) throw new Error('No active workflow in this session.')
    return this.active
  }

  private notify(text: string): void {
    ;(this.deps.enqueueCommand ?? ((value, mode) => enqueue({ value, mode })))(
      text,
      'task-notification',
    )
  }

  private enqueueStep(value: string): void {
    ;(this.deps.enqueueCommand ?? ((v, mode) => enqueue({ value: v, mode })))(
      value,
      'prompt',
    )
  }

  private async persist(event: string, data?: Record<string, unknown>): Promise<void> {
    const active = this.active
    if (!active) return
    const store = await this.store()
    store.updateRun(active.runId, active.engine.snapshot)
    store.appendEvent(active.runId, event, data)
    const line = this.getStatus()
    if (line) this.deps.onTransition?.(line)
  }

  /**
   * Install the task-panel bridge (idempotent). The sink fires for runs it
   * has explicitly tracked via trackWorkflowRun; others are ignored.
   */
  setTransitionSink(sink: (line: RuntimeStatusLine) => void): void {
    this.deps.onTransition = sink
  }

  private nodeContext(): { input: Record<string, unknown>; outputs: Record<string, unknown> } {
    const snap = this.requireActiveEngine().snapshot
    return { input: snap.input, outputs: snap.outputs }
  }

  private requireActiveEngine(): WorkflowEngine {
    if (!this.active) throw new Error('No active workflow')
    return this.active.engine
  }

  private buildStepPrompt(node: string, def: WorkflowNodeDef): string {
    const active = this.requireActive()
    const attempt = active.engine.snapshot.attempts[node] ?? 1
    let instruction: string
    if (def.kind === 'decision') {
      instruction = `Call the Workflow tool with action="submit" and output your choice verbatim. Valid choices: ${def.choices.map(c => JSON.stringify(c)).join(', ')}.`
    } else {
      instruction =
        def.kind === 'agent' && def.expectedOutput
          ? `When done, call the Workflow tool with action="submit". Expected output shape: ${def.expectedOutput}`
          : 'When done, call the Workflow tool with action="submit" and pass your structured result as output.'
    }
    const promptText = def.kind === 'agent' || def.kind === 'decision'
      ? def.prompt(this.nodeContext())
      : ''
    return [
      `<!--wf:${active.runId}-->`,
      '<workflow-step>',
      `workflow: ${active.workflow.name}`,
      `node: ${node}`,
      `attempt: ${attempt}`,
      '',
      promptText,
      '',
      instruction,
      '</workflow-step>',
    ].join('\n')
  }

  private async runLocalNode(node: string, def: WorkflowNodeDef): Promise<unknown> {
    switch (def.kind) {
      case 'compute':
        return await def.run(this.nodeContext())
      case 'shell': {
        const command = typeof def.exec === 'function' ? def.exec(this.nodeContext()) : def.exec
        const stdout = await (this.deps.execShell ?? defaultExecShell)(
          command,
          def.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
        )
        return def.parse ? def.parse(stdout, this.nodeContext()) : stdout.trim()
      }
      case 'notify': {
        const message = typeof def.message === 'function' ? def.message(this.nodeContext()) : def.message
        this.notify(message)
        return message
      }
      case 'checkpoint': {
        const message = typeof def.message === 'function' ? def.message(this.nodeContext()) : def.message
        this.notify(
          `Workflow paused at checkpoint "${node}": ${message}\nAnswer with /workflows answer <json>`,
        )
        return undefined // caller keeps the node open awaiting answer()
      }
      case 'agent':
      case 'decision':
        return undefined
    }
  }

  /** Drive the state machine until it must wait on the model or a human. */
  private async advance(): Promise<void> {
    if (this.advancing) return
    this.advancing = true
    try {
      for (;;) {
        const active = this.active
        if (!active) break
        const action = active.engine.peek()
        if (action.type === 'stop') {
          await this.persist(`run_${action.reason}`)
          if (action.reason === 'completed') {
            this.notify(`Workflow "${active.workflow.name}" completed (${active.runId}, ${active.engine.snapshot.stepCount} steps)`)
          } else if (action.reason === 'failed') {
            this.notify(`Workflow "${active.workflow.name}" failed: ${active.engine.snapshot.error}`)
          } else if (action.reason === 'paused') {
            this.notify(`Workflow "${active.workflow.name}" paused before "${active.engine.snapshot.currentNode}" — /workflows resume to continue`)
          }
          break
        }
        if (action.type === 'await_result') break

        const { node, def } = active.engine.beginNode()
        await this.persist('node_started', { node })

        if (def.kind === 'agent' || def.kind === 'decision') {
          this.enqueueStep(this.buildStepPrompt(node, def))
          break
        }

        if (def.kind === 'checkpoint') {
          // beginNode already flipped status to waiting; surface the gate.
          await this.runLocalNode(node, def)
          await this.persist('waiting_user', { node })
          break
        }

        try {
          const output = await this.runLocalNode(node, def)
          active.engine.completeNode(output)
          await this.persist('node_completed', { node })
        } catch (error) {
          active.engine.failNode(error instanceof Error ? error.message : String(error))
          await this.persist('node_failed', { node })
          if (active.engine.status === 'failed') {
            this.notify(`Workflow "${active.workflow.name}" failed at "${node}": ${active.engine.snapshot.error}`)
            break
          }
        }
      }
    } finally {
      this.advancing = false
    }
  }
}

let singleton: WorkflowRuntime | null = null

export function getWorkflowRuntime(): WorkflowRuntime {
  singleton ??= new WorkflowRuntime()
  return singleton
}

/** Test-only: reset the process-wide singleton. */
export function resetWorkflowRuntimeForTests(): void {
  singleton = null
}
