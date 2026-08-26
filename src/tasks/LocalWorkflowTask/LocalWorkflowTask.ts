// Background-task surface for workflow runs. Pure UI bridging: the run
// itself lives in WorkflowRuntime + SQLite; this module mirrors each tracked
// run into the task registry so it shows up in the footer pill and the
// Shift+Down task dialog with live node/step progress.

import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import type { RuntimeStatusLine } from '../../workflows/runtime.js'
import { getWorkflowRuntime } from '../../workflows/runtime.js'

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  runId: string
  workflowName: string
}

const tracked = new Map<string, { taskId: string; setAppState: SetAppState }>()

function describe(line: RuntimeStatusLine): string {
  const at =
    line.activeNode ?? line.currentNode ?? (line.status === 'completed' ? 'done' : '—')
  const suffix = line.lastError ? ` · last error: ${line.lastError}` : ''
  return `${line.name} · ${at} · step ${line.stepCount}${suffix}`
}

function terminalStatusOf(line: RuntimeStatusLine): 'completed' | 'failed' | null {
  if (line.status === 'completed') return 'completed'
  if (line.status === 'failed' || line.status === 'cancelled') return 'failed'
  return null
}

/** Mirror a runtime transition into its task entry (no-op if untracked). */
function syncFromLine(line: RuntimeStatusLine): void {
  const entry = tracked.get(line.runId)
  if (!entry) return
  updateTaskState<LocalWorkflowTaskState>(entry.taskId, entry.setAppState, task => {
    const terminal = terminalStatusOf(line)
    return {
      ...task,
      description: describe(line),
      status: terminal ?? 'running',
      endTime: terminal ? Date.now() : task.endTime,
      notified: Boolean(terminal),
    }
  })
  if (terminalStatusOf(line)) tracked.delete(line.runId)
}

let sinkInstalled = false

/**
 * Start mirroring a run into the task panel. Call right after runtime.start()
 * or recover() using runtime.getStatus(). Idempotent per runId.
 */
export function trackWorkflowRun(setAppState: SetAppState, line: RuntimeStatusLine): void {
  if (!sinkInstalled) {
    getWorkflowRuntime().setTransitionSink(syncFromLine)
    sinkInstalled = true
  }
  if (tracked.has(line.runId)) return
  if (terminalStatusOf(line)) return // nothing to watch
  const id = generateTaskId('local_workflow')
  const task: LocalWorkflowTaskState = {
    ...createTaskStateBase(id, 'local_workflow', describe(line)),
    type: 'local_workflow',
    status: 'running',
    runId: line.runId,
    workflowName: line.name,
  }
  registerTask(task, setAppState)
  tracked.set(line.runId, { taskId: id, setAppState })
}

/** Kill from the task panel: cancel the run and mark the task killed. */
export function killWorkflowTask(taskId: string, setAppState: SetAppState): void {
  getWorkflowRuntime().cancel()
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'killed',
    endTime: Date.now(),
    notified: true,
  }))
  for (const [runId, entry] of tracked) {
    if (entry.taskId === taskId) tracked.delete(runId)
  }
}

/**
 * Agent steps execute inline in this conversation — there is no separable
 * sub-agent to skip or retry independently. Surface that honestly instead
 * of pretending; kill above remains fully functional.
 */
function noteUnsupported(
  taskId: string,
  action: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    description: `${task.description} · ${action} not supported for inline steps`,
  }))
}

export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  noteUnsupported(taskId, `skip ${agentId}`, setAppState)
}

export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  noteUnsupported(taskId, `retry ${agentId}`, setAppState)
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',

  async kill(taskId, setAppState) {
    killWorkflowTask(taskId, setAppState)
  },
}
