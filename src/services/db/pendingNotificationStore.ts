/**
 * Durable mirror of queued task notifications.
 *
 * The command queue (utils/messageQueueManager.ts) is process memory — a
 * crash or TUI restart silently drops queued `task-notification` commands
 * and the model never learns the background task finished. This store
 * mirrors those commands into the session SQLite database so the next
 * interactive launch of the same project can replay them. Modeled after
 * opencode's persisted background-job markers (MIT, packages/core/src/job.ts
 * `persistBackground` + session/execution/restart.ts `resumeSuspendedSessions`).
 *
 * Semantics:
 * - Writes are INSERT OR IGNORE keyed by the notification uuid, so producer
 *   retries and queue replays are idempotent (at-most-once per uuid).
 * - Rows are deleted when the command is delivered or removed from the
 *   queue; the table only ever holds undelivered notifications. A crash
 *   between delivery attempts therefore replays (at-least-once), with the
 *   uuid dedup collapsing duplicates within a process.
 * - Only string-valued commands are mirrored; content-block notifications
 *   (bridge/remote payloads with images) are skipped.
 * - Every accessor is best-effort and failure-tolerant: persistence must
 *   never break the queue. Under bun test the store is a no-op unless a
 *   test explicitly injects a backend via __setPendingNotificationStoreForTests.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getNodeEnv } from '../../utils/sessionStorage.js'
import { asAgentId } from '../../types/ids.js'
import { validateUuid } from '../../utils/uuid.js'
import type {
  PromptInputMode,
  QueuedCommand,
  QueuePriority,
} from '../../types/textInputTypes.js'
import type { AgentId } from '../../types/ids.js'
import { openDatabaseSync, type SqliteDatabase } from './driver.js'
import { runMigrations } from './migrations/index.js'

export type NotificationPersistenceContext = {
  projectDir: string
  sessionId: string | null
}

export interface NotificationPersistence {
  persist(cmd: QueuedCommand, ctx: NotificationPersistenceContext): void
  forget(uuids: readonly string[]): void
  load(projectDir: string): QueuedCommand[]
}

// ===========================================================================
// SQLite backend
// ===========================================================================

let cachedDb: SqliteDatabase | null = null

function defaultStorePath(): string {
  return join(getClaudeConfigHomeDir(), 'sessions', 'sessions.db')
}

function getDb(): SqliteDatabase | null {
  if (cachedDb) return cachedDb
  try {
    const path = defaultStorePath()
    mkdirSync(dirname(path), { recursive: true })
    // Own connection (not the SessionStore singleton): migrations are
    // idempotent and WAL allows multiple connections, and this keeps the
    // notification mirror independent of SessionStore's lifecycle.
    const db = openDatabaseSync(path)
    runMigrations(db)
    cachedDb = db
    return db
  } catch (error) {
    console.warn(
      '[pendingNotificationStore] database unavailable, notifications will not persist:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

function persistSqlite(
  cmd: QueuedCommand,
  ctx: NotificationPersistenceContext,
): void {
  const db = getDb()
  if (!db || typeof cmd.value !== 'string') return
  db.run(
    `INSERT OR IGNORE INTO pending_notifications
       (uuid, project_dir, session_id, mode, priority, agent_id, is_meta, value, origin_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cmd.uuid ?? null,
      ctx.projectDir,
      ctx.sessionId,
      cmd.mode,
      cmd.priority ?? 'later',
      cmd.agentId ?? null,
      cmd.isMeta ? 1 : 0,
      cmd.value,
      cmd.origin ? JSON.stringify(cmd.origin) : null,
      Date.now(),
    ],
  )
}

function forgetSqlite(uuids: readonly string[]): void {
  if (uuids.length === 0) return
  const db = getDb()
  if (!db) return
  const placeholders = uuids.map(() => '?').join(', ')
  db.run(
    `DELETE FROM pending_notifications WHERE uuid IN (${placeholders})`,
    [...uuids],
  )
}

function loadSqlite(projectDir: string): QueuedCommand[] {
  const db = getDb()
  if (!db) return []
  const rows = db
    .query(
      `SELECT uuid, mode, priority, agent_id, is_meta, value, origin_json
         FROM pending_notifications
        WHERE project_dir = ?
        ORDER BY created_at, uuid`,
    )
    .all(projectDir) as Array<Record<string, unknown>>
  const commands: QueuedCommand[] = []
  for (const row of rows) {
    // uuid/agentId round-trip through TEXT columns; re-brand with the
    // official validators so the reconstructed commands satisfy QueuedCommand.
    const uuid = validateUuid(row.uuid)
    const rawAgentId = row.agent_id == null ? null : String(row.agent_id)
    commands.push({
      value: String(row.value ?? ''),
      mode: String(row.mode ?? 'task-notification') as PromptInputMode,
      priority: String(row.priority ?? 'later') as QueuePriority,
      uuid: uuid ?? undefined,
      agentId: rawAgentId ? asAgentId(rawAgentId) : undefined,
      isMeta: Number(row.is_meta ?? 0) === 1,
      origin: row.origin_json
        ? (JSON.parse(String(row.origin_json)) as QueuedCommand['origin'])
        : undefined,
    })
  }
  return commands
}

export const sqliteNotificationPersistence: NotificationPersistence = {
  persist: persistSqlite,
  forget: forgetSqlite,
  load: loadSqlite,
}

// ===========================================================================
// Resolution (test seam + no-op under bun test)
// ===========================================================================

const noopPersistence: NotificationPersistence = {
  persist: () => {},
  forget: () => {},
  load: () => [],
}

let testOverride: NotificationPersistence | null = null

export function notificationPersistence(): NotificationPersistence {
  if (testOverride) return testOverride
  if (getNodeEnv() === 'test') return noopPersistence
  return sqliteNotificationPersistence
}

// ---------------------------------------------------------------------------
// Facades used by utils/messageQueueManager.ts — resolve the backend at call
// time so tests can swap it via __setPendingNotificationStoreForTests.
// ---------------------------------------------------------------------------

export function persistQueuedNotification(
  cmd: QueuedCommand,
  ctx: NotificationPersistenceContext,
): void {
  notificationPersistence().persist(cmd, ctx)
}

export function forgetPersistedNotifications(uuids: readonly string[]): void {
  notificationPersistence().forget(uuids)
}

export function loadPersistedNotifications(projectDir: string): QueuedCommand[] {
  return notificationPersistence().load(projectDir)
}

// ===========================================================================
// In-flight background task tracking
//
// pending_notifications covers completions queued-but-not-delivered; this
// second mirror covers tasks that were still RUNNING at process death. One
// row per spawned background shell task: written at spawn, deleted at the
// terminal notification (or kill). A row that survives a restart means the
// task was running when the process died, and utils/task/recovery.ts
// converts it into an "interrupted" notification on the next launch —
// mirroring opencode's "Command cancelled because the server restarted"
// recovery (MIT, session/execution/restart.ts recoverShell).
// ===========================================================================

export type BackgroundTaskRow = {
  taskId: string
  projectDir: string
  sessionId: string | null
  description: string
  kind: string
  outputPath: string
  startedAt: number
}

export interface BackgroundTaskPersistence {
  track(row: BackgroundTaskRow): void
  untrack(taskId: string): void
  loadOrphaned(projectDir: string): BackgroundTaskRow[]
}

function trackSqlite(row: BackgroundTaskRow): void {
  const db = getDb()
  if (!db) return
  db.run(
    `INSERT OR REPLACE INTO background_tasks
       (task_id, project_dir, session_id, description, kind, output_path, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.taskId,
      row.projectDir,
      row.sessionId,
      row.description,
      row.kind,
      row.outputPath,
      row.startedAt,
    ],
  )
}

function untrackSqlite(taskId: string): void {
  const db = getDb()
  if (!db) return
  db.run('DELETE FROM background_tasks WHERE task_id = ?', [taskId])
}

function loadOrphanedSqlite(projectDir: string): BackgroundTaskRow[] {
  const db = getDb()
  if (!db) return []
  const rows = db
    .query(
      `SELECT task_id, session_id, description, kind, output_path, started_at
         FROM background_tasks
        WHERE project_dir = ?
        ORDER BY started_at, task_id`,
    )
    .all(projectDir) as Array<Record<string, unknown>>
  return rows.map(row => ({
    taskId: String(row.task_id ?? ''),
    projectDir,
    sessionId: (row.session_id as string | null) ?? null,
    description: String(row.description ?? ''),
    kind: String(row.kind ?? 'bash'),
    outputPath: String(row.output_path ?? ''),
    startedAt: Number(row.started_at ?? 0),
  }))
}

export const sqliteBackgroundTaskPersistence: BackgroundTaskPersistence = {
  track: trackSqlite,
  untrack: untrackSqlite,
  loadOrphaned: loadOrphanedSqlite,
}

let backgroundTaskTestOverride: BackgroundTaskPersistence | null = null

export function backgroundTaskPersistence(): BackgroundTaskPersistence {
  if (backgroundTaskTestOverride) return backgroundTaskTestOverride
  if (getNodeEnv() === 'test') return { track: () => {}, untrack: () => {}, loadOrphaned: () => [] }
  return sqliteBackgroundTaskPersistence
}

export function trackBackgroundTask(row: BackgroundTaskRow): void {
  try {
    backgroundTaskPersistence().track(row)
  } catch (error) {
    console.warn(
      '[pendingNotificationStore] background task track failed:',
      error instanceof Error ? error.message : error,
    )
  }
}

export function untrackBackgroundTask(taskId: string): void {
  try {
    backgroundTaskPersistence().untrack(taskId)
  } catch (error) {
    console.warn(
      '[pendingNotificationStore] background task untrack failed:',
      error instanceof Error ? error.message : error,
    )
  }
}

export function loadOrphanedBackgroundTasks(
  projectDir: string,
): BackgroundTaskRow[] {
  try {
    return backgroundTaskPersistence().loadOrphaned(projectDir)
  } catch (error) {
    console.warn(
      '[pendingNotificationStore] background task load failed:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

/**
 * Test-only: inject the background-task persistence backend (pass the
 * exported `sqliteBackgroundTaskPersistence` to exercise the real SQLite
 * path, or a fake to observe track/untrack calls). Pass null to clear.
 */
export function __setBackgroundTaskStoreForTests(
  impl: BackgroundTaskPersistence | null,
): void {
  backgroundTaskTestOverride = impl
}

/**
 * Test-only: inject a persistence backend (pass the exported
 * `sqliteNotificationPersistence` to exercise the real SQLite path, or a
 * fake to observe persist/forget calls). Pass null to clear.
 */
export function __setPendingNotificationStoreForTests(
  impl: NotificationPersistence | null,
): void {
  testOverride = impl
}

/**
 * Test-only: drop the cached connection so the next access re-opens with
 * the current environment (tests that redirect CLAUDE_CONFIG_DIR per test).
 */
export function __resetPendingNotificationStoreForTests(): void {
  if (cachedDb) {
    try {
      cachedDb.close()
    } catch {
      // already closed
    }
  }
  cachedDb = null
}
