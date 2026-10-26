import { join } from 'path'
import { z } from 'zod/v4'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import { uniq } from './array.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { errorMessage } from './errors.js'
import { lazySchema } from './lazySchema.js'
import { logError } from './log.js'
import { createSignal } from './signal.js'
import { jsonParse } from './slowOperations.js'
import { getTeamName } from './teammate.js'
import { getTeammateContext } from './teammateContext.js'
import { getSessionStore } from '../services/db/SessionStore.js'

// Listeners for task list updates (used for immediate UI refresh in same process)
const tasksUpdated = createSignal()

/**
 * Team name set by the leader when creating a team.
 * Used by getTaskListId() so the leader's tasks are stored under the team name
 * (matching where tmux/iTerm2 teammates look), not under the session ID.
 */
let leaderTeamName: string | undefined

/**
 * Sets the leader's team name for task list resolution.
 * Called by TeamCreateTool when a team is created.
 */
export function setLeaderTeamName(teamName: string): void {
  if (leaderTeamName === teamName) return
  leaderTeamName = teamName
  // Changing the task list ID is a "tasks updated" event for subscribers —
  // they're now looking at a different directory.
  notifyTasksUpdated()
}

/**
 * Clears the leader's team name.
 * Called when a team is deleted.
 */
export function clearLeaderTeamName(): void {
  if (leaderTeamName === undefined) return
  leaderTeamName = undefined
  notifyTasksUpdated()
}

/**
 * Register a listener to be called when tasks are updated in this process.
 * Returns an unsubscribe function.
 */
export const onTasksUpdated = tasksUpdated.subscribe

/**
 * Notify listeners that tasks have been updated.
 * Called internally after createTask, updateTask, etc.
 * Wraps emit in try/catch so listener failures never propagate to callers
 * (task mutations must succeed from the caller's perspective).
 */
export function notifyTasksUpdated(): void {
  try {
    tasksUpdated.emit()
  } catch {
    // Ignore listener errors — task mutations must not fail due to notification issues
  }
}

export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export const TaskStatusSchema = lazySchema(() =>
  z.enum(['pending', 'in_progress', 'completed']),
)
export type TaskStatus = z.infer<ReturnType<typeof TaskStatusSchema>>

export const TaskSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    subject: z.string(),
    description: z.string(),
    activeForm: z.string().optional(), // present continuous form for spinner (e.g., "Running tests")
    owner: z.string().optional(), // agent ID
    status: TaskStatusSchema(),
    blocks: z.array(z.string()), // task IDs this task blocks
    blockedBy: z.array(z.string()), // task IDs that block this task
    metadata: z.record(z.string(), z.unknown()).optional(), // arbitrary metadata
  }),
)
export type Task = z.infer<ReturnType<typeof TaskSchema>>

type TaskListDocument = { tasks: Task[]; highWaterMark: number }

function readTaskListDocument(taskListId: string): TaskListDocument {
  const raw = getSessionStore().getAppDocument(
    'task-lists',
    sanitizePathComponent(taskListId),
  )
  if (!raw) return { tasks: [], highWaterMark: 0 }
  try {
    const parsed = JSON.parse(raw) as Partial<TaskListDocument>
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      highWaterMark: typeof parsed.highWaterMark === 'number' ? parsed.highWaterMark : 0,
    }
  } catch {
    return { tasks: [], highWaterMark: 0 }
  }
}

function updateTaskListDocument<T>(
  taskListId: string,
  update: (document: TaskListDocument) => T,
): T {
  let result!: T
  getSessionStore().updateAppDocument(
    'task-lists',
    sanitizePathComponent(taskListId),
    raw => {
      let document: TaskListDocument = { tasks: [], highWaterMark: 0 }
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<TaskListDocument>
          document = {
            tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
            highWaterMark: typeof parsed.highWaterMark === 'number' ? parsed.highWaterMark : 0,
          }
        } catch {
          // Start with an empty record if an invalid DB document is encountered.
        }
      }
      result = update(document)
      return JSON.stringify(document)
    },
  )
  return result
}

export function isTodoV2Enabled(): boolean {
  // Force-enable tasks in non-interactive mode (e.g. SDK users who want Task tools over TodoWrite)
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TASKS)) {
    return true
  }
  return !getIsNonInteractiveSession()
}

/**
 * Resets the task list for a new swarm - clears any existing tasks.
 * Writes a high water mark file to prevent ID reuse after reset.
 * Should be called when a new swarm is created to ensure task numbering starts at 1.
 * Updates the task-list document atomically in SQLite.
 */
export async function resetTaskList(taskListId: string): Promise<void> {
  updateTaskListDocument(taskListId, document => {
    for (const task of document.tasks) {
      const numericId = Number.parseInt(task.id, 10)
      if (!Number.isNaN(numericId)) document.highWaterMark = Math.max(document.highWaterMark, numericId)
    }
    document.tasks = []
  })
  notifyTasksUpdated()
}

/**
 * Gets the task list ID based on the current context.
 * Priority:
 * 1. CLAUDE_CODE_TASK_LIST_ID - explicit task list ID
 * 2. In-process teammate: leader's team name (so teammates share the leader's task list)
 * 3. CLAUDE_CODE_TEAM_NAME - set when running as a process-based teammate
 * 4. Leader team name - set when the leader creates a team via TeamCreate
 * 5. Session ID - fallback for standalone sessions
 */
export function getTaskListId(): string {
  if (process.env.CLAUDE_CODE_TASK_LIST_ID) {
    return process.env.CLAUDE_CODE_TASK_LIST_ID
  }
  // In-process teammates use the leader's team name so they share the same
  // task list that tmux/iTerm2 teammates also resolve to.
  const teammateCtx = getTeammateContext()
  if (teammateCtx) {
    return teammateCtx.teamName
  }
  return getTeamName() || leaderTeamName || getSessionId()
}

/**
 * Sanitizes a string for safe use in file paths.
 * Removes path traversal characters and other potentially dangerous characters.
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
export function sanitizePathComponent(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function getTasksDir(taskListId: string): string {
  return join(
    getClaudeConfigHomeDir(),
    'tasks',
    sanitizePathComponent(taskListId),
  )
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return join(getTasksDir(taskListId), `${sanitizePathComponent(taskId)}.json`)
}

export async function ensureTasksDir(taskListId: string): Promise<void> {
  // Task lists live in codev.db; retained as an async compatibility seam for
  // callers that used to create a filesystem task directory.
  void taskListId
}

/**
 * Creates a new task with a unique ID using an atomic SQLite update.
 */
export async function createTask(
  taskListId: string,
  taskData: Omit<Task, 'id'>,
): Promise<string> {
  const id = updateTaskListDocument(taskListId, document => {
    const highestId = Math.max(
      document.highWaterMark,
      ...document.tasks.map(task => Number.parseInt(task.id, 10)).filter(Number.isFinite),
      0,
    )
    const nextId = highestId + 1
    const id = String(nextId)
    const task: Task = { id, ...taskData }
    document.tasks.push(task)
    document.highWaterMark = nextId
    return id
  })
  notifyTasksUpdated()
  return id
}

export async function getTask(
  taskListId: string,
  taskId: string,
): Promise<Task | null> {
  try {
    const data = readTaskListDocument(taskListId).tasks.find(task => task.id === taskId)
    if (!data) return null

    // TEMPORARY: Migrate old status names for existing sessions (ant-only)
    if (process.env.USER_TYPE === 'ant') {
      if (data.status === 'open') data.status = 'pending'
      else if (data.status === 'resolved') data.status = 'completed'
      // Migrate development task statuses to in_progress
      else if (
        data.status &&
        ['planning', 'implementing', 'reviewing', 'verifying'].includes(
          data.status,
        )
      ) {
        data.status = 'in_progress'
      }
    }
    const parsed = TaskSchema().safeParse(data)
    if (!parsed.success) {
      logForDebugging(
        `[Tasks] Task ${taskId} failed schema validation: ${parsed.error.message}`,
      )
      return null
    }
    return parsed.data
  } catch (e) {
    logForDebugging(`[Tasks] Failed to read task ${taskId} from codev.db: ${errorMessage(e)}`)
    logError(e)
    return null
  }
}

// Atomic task update helper used by update and claim operations.
async function updateTaskUnsafe(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  const updated = updateTaskListDocument(taskListId, document => {
    const index = document.tasks.findIndex(task => task.id === taskId)
    if (index < 0) return null
    const current = document.tasks[index]!
    const next: Task = { ...current, ...updates, id: taskId }
    document.tasks[index] = next
    return next
  })
  if (!updated) return null
  notifyTasksUpdated()
  return updated
}

export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  return updateTaskUnsafe(taskListId, taskId, updates)
}

export async function deleteTask(
  taskListId: string,
  taskId: string,
): Promise<boolean> {
  try {
    const removed = updateTaskListDocument(taskListId, document => {
      const index = document.tasks.findIndex(task => task.id === taskId)
      if (index < 0) return false
      const numericId = Number.parseInt(taskId, 10)
      if (!Number.isNaN(numericId)) document.highWaterMark = Math.max(document.highWaterMark, numericId)
      document.tasks.splice(index, 1)
      for (const task of document.tasks) {
        task.blocks = task.blocks.filter(id => id !== taskId)
        task.blockedBy = task.blockedBy.filter(id => id !== taskId)
      }
      return true
    })
    if (!removed) return false
    notifyTasksUpdated()
    return true
  } catch {
    return false
  }
}

export async function listTasks(taskListId: string): Promise<Task[]> {
  return readTaskListDocument(taskListId).tasks
    .map(task => TaskSchema().safeParse(task))
    .filter((result): result is { success: true; data: Task } => result.success)
    .map(result => result.data)
}

export async function blockTask(
  taskListId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<boolean> {
  const [fromTask, toTask] = await Promise.all([
    getTask(taskListId, fromTaskId),
    getTask(taskListId, toTaskId),
  ])
  if (!fromTask || !toTask) {
    return false
  }

  // Update source task: A blocks B
  if (!fromTask.blocks.includes(toTaskId)) {
    await updateTask(taskListId, fromTaskId, {
      blocks: [...fromTask.blocks, toTaskId],
    })
  }

  // Update target task: B is blockedBy A
  if (!toTask.blockedBy.includes(fromTaskId)) {
    await updateTask(taskListId, toTaskId, {
      blockedBy: [...toTask.blockedBy, fromTaskId],
    })
  }

  return true
}

export type ClaimTaskResult = {
  success: boolean
  reason?:
    | 'task_not_found'
    | 'already_claimed'
    | 'already_resolved'
    | 'blocked'
    | 'agent_busy'
  task?: Task
  busyWithTasks?: string[] // task IDs the agent is busy with (when reason is 'agent_busy')
  blockedByTasks?: string[] // task IDs blocking this task (when reason is 'blocked')
}

export type ClaimTaskOptions = {
  /**
   * If true, checks whether the agent is already busy (owns other open tasks)
   * before allowing the claim. This check is performed atomically with the claim
   * using a task-list-level lock to prevent TOCTOU race conditions.
   */
  checkAgentBusy?: boolean
}

/**
 * Attempts to claim a task for an agent with file locking to prevent race conditions.
 * Returns success if the task was claimed, or a reason if it wasn't.
 *
 * When checkAgentBusy is true, uses a task-list-level lock to atomically check
 * if the agent owns any other open tasks before claiming.
 */
export async function claimTask(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  options: ClaimTaskOptions = {},
): Promise<ClaimTaskResult> {
  try {
    const result = updateTaskListDocument(taskListId, document => {
      const task = document.tasks.find(item => item.id === taskId)
      if (!task) return { success: false, reason: 'task_not_found' } as ClaimTaskResult
      if (task.owner && task.owner !== claimantAgentId) {
        return { success: false, reason: 'already_claimed', task } as ClaimTaskResult
      }
      if (task.status === 'completed') {
        return { success: false, reason: 'already_resolved', task } as ClaimTaskResult
      }
      const unresolved = new Set(document.tasks.filter(item => item.status !== 'completed').map(item => item.id))
      const blockedByTasks = task.blockedBy.filter(id => unresolved.has(id))
      if (blockedByTasks.length) {
        return { success: false, reason: 'blocked', task, blockedByTasks } as ClaimTaskResult
      }
      if (options.checkAgentBusy) {
        const busy = document.tasks.filter(item =>
          item.status !== 'completed' && item.owner === claimantAgentId && item.id !== taskId,
        )
        if (busy.length) {
          return { success: false, reason: 'agent_busy', task, busyWithTasks: busy.map(item => item.id) } as ClaimTaskResult
        }
      }
      task.owner = claimantAgentId
      return { success: true, task: { ...task } } as ClaimTaskResult
    })
    if (result.success) notifyTasksUpdated()
    return result
  } catch (error) {
    logForDebugging(`[Tasks] Failed to claim task ${taskId}: ${errorMessage(error)}`)
    logError(error)
    return { success: false, reason: 'task_not_found' }
  }
}

/**
 * Team member info (subset of TeamFile member structure)
 */
export type TeamMember = {
  agentId: string
  name: string
  agentType?: string
}

/**
 * Agent status based on task ownership
 */
export type AgentStatus = {
  agentId: string
  name: string
  agentType?: string
  status: 'idle' | 'busy'
  currentTasks: string[] // task IDs the agent owns
}

/**
 * Sanitizes a name for use in file paths
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

/**
 * Reads team members from the team file
 */
async function readTeamMembers(
  teamName: string,
): Promise<{ leadAgentId: string; members: TeamMember[] } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readTeamFileAsync } = require('./swarm/teamHelpers.js') as
      typeof import('./swarm/teamHelpers.js')
    const teamFile = await readTeamFileAsync(teamName)
    if (!teamFile) return null
    return {
      leadAgentId: teamFile.leadAgentId,
      members: teamFile.members.map(m => ({
        agentId: m.agentId,
        name: m.name,
        agentType: m.agentType,
      })),
    }
  } catch (e) {
    logForDebugging(
      `[Tasks] Failed to read team document for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * Gets the status of all agents in a team based on task ownership.
 * An agent is considered "idle" if they don't own any open tasks.
 * An agent is considered "busy" if they own at least one open task.
 *
 * @param teamName - The name of the team (also used as taskListId)
 * @returns Array of agent statuses, or null if team not found
 */
export async function getAgentStatuses(
  teamName: string,
): Promise<AgentStatus[] | null> {
  const teamData = await readTeamMembers(teamName)
  if (!teamData) {
    return null
  }

  const taskListId = sanitizeName(teamName)
  const allTasks = await listTasks(taskListId)

  // Get unresolved tasks grouped by owner (open or in_progress)
  const unresolvedTasksByOwner = new Map<string, string[]>()
  for (const task of allTasks) {
    if (task.status !== 'completed' && task.owner) {
      const existing = unresolvedTasksByOwner.get(task.owner) || []
      existing.push(task.id)
      unresolvedTasksByOwner.set(task.owner, existing)
    }
  }

  // Build status for each agent (leader is already in members)
  return teamData.members.map(member => {
    // Check both name (new) and agentId (legacy) for backwards compatibility
    const tasksByName = unresolvedTasksByOwner.get(member.name) || []
    const tasksById = unresolvedTasksByOwner.get(member.agentId) || []
    const currentTasks = uniq([...tasksByName, ...tasksById])
    return {
      agentId: member.agentId,
      name: member.name,
      agentType: member.agentType,
      status: currentTasks.length === 0 ? 'idle' : 'busy',
      currentTasks,
    }
  })
}

/**
 * Result of unassigning tasks from a teammate
 */
export type UnassignTasksResult = {
  unassignedTasks: Array<{ id: string; subject: string }>
  notificationMessage: string
}

/**
 * Unassigns all open tasks from a teammate and builds a notification message.
 * Used when a teammate is killed or gracefully shuts down.
 *
 * @param teamName - The team/task list name
 * @param teammateId - The teammate's agent ID
 * @param teammateName - The teammate's display name
 * @param reason - How the teammate exited ('terminated' | 'shutdown')
 * @returns The unassigned tasks and a formatted notification message
 */
export async function unassignTeammateTasks(
  teamName: string,
  teammateId: string,
  teammateName: string,
  reason: 'terminated' | 'shutdown',
): Promise<UnassignTasksResult> {
  const tasks = await listTasks(teamName)
  const unresolvedAssignedTasks = tasks.filter(
    t =>
      t.status !== 'completed' &&
      (t.owner === teammateId || t.owner === teammateName),
  )

  // Unassign each task and reset status to open
  for (const task of unresolvedAssignedTasks) {
    await updateTask(teamName, task.id, { owner: undefined, status: 'pending' })
  }

  if (unresolvedAssignedTasks.length > 0) {
    logForDebugging(
      `[Tasks] Unassigned ${unresolvedAssignedTasks.length} task(s) from ${teammateName}`,
    )
  }

  // Build notification message
  const actionVerb =
    reason === 'terminated' ? 'was terminated' : 'has shut down'
  let notificationMessage = `${teammateName} ${actionVerb}.`
  if (unresolvedAssignedTasks.length > 0) {
    const taskList = unresolvedAssignedTasks
      .map(t => `#${t.id} "${t.subject}"`)
      .join(', ')
    notificationMessage += ` ${unresolvedAssignedTasks.length} task(s) were unassigned: ${taskList}. Use TaskList to check availability and TaskUpdate with owner to reassign them to idle teammates.`
  }

  return {
    unassignedTasks: unresolvedAssignedTasks.map(t => ({
      id: t.id,
      subject: t.subject,
    })),
    notificationMessage,
  }
}

export const DEFAULT_TASKS_MODE_TASK_LIST_ID = 'tasklist'
