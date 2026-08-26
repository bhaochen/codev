import { Database } from 'bun:sqlite'
import type { SQLQueryBindings } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { generateWordSlug } from '../utils/words.js'
import type { RunStatus, WorkflowSnapshot } from './types.js'

export const ACTIVE_STATUSES: readonly RunStatus[] = ['running', 'paused', 'waiting']

export function defaultStorePath(): string {
  return join(getClaudeConfigHomeDir(), 'workflows', 'state.sqlite')
}

export type NewRun = {
  workflowName: string
  sourcePath?: string
  sessionId: string
  input: Record<string, unknown>
  snapshot: WorkflowSnapshot
}

export type RunRecord = {
  id: string
  workflowName: string
  sourcePath: string | null
  status: RunStatus
  /** Session this run belongs to; only it may resume a parked run. */
  sessionId: string
  /** Active executor lease; guards against two windows of the same session. */
  ownerLease: string | null
  input: Record<string, unknown>
  snapshot: WorkflowSnapshot
  createdAt: number
  updatedAt: number
}

export type WorkflowEvent = {
  seq: number
  runId: string
  at: number
  type: string
  data: Record<string, unknown> | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  source_path TEXT,
  status TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_lease TEXT,
  input_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
`

interface RunRow {
  id: string
  workflow_name: string
  source_path: string | null
  status: string
  session_id: string
  owner_lease: string | null
  input_json: string
  snapshot_json: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    sourcePath: row.source_path,
    status: row.status as RunStatus,
    sessionId: row.session_id,
    ownerLease: row.owner_lease,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    snapshot: JSON.parse(row.snapshot_json) as WorkflowSnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Durable run state. One SQLite database backs every run; writes are keyed
 * by run id and the runs table carries the owning session so parked runs
 * can only be claimed by their original conversation.
 */
export class WorkflowStore {
  private readonly db: Database

  private constructor(db: Database) {
    this.db = db
  }

  static open(path: string = defaultStorePath()): WorkflowStore {
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path, { create: true })
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec(SCHEMA)
    return new WorkflowStore(db)
  }

  close(): void {
    this.db.close()
  }

  createRun(run: NewRun): string {
    const now = Date.now()
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = generateWordSlug()
      try {
        this.db.run(
          `INSERT INTO runs
             (id, workflow_name, source_path, status, session_id, owner_lease,
              input_json, snapshot_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          [
            id,
            run.workflowName,
            run.sourcePath ?? null,
            run.snapshot.status,
            run.sessionId,
            JSON.stringify(run.input),
            JSON.stringify(run.snapshot),
            now,
            now,
          ],
        )
        return id
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('UNIQUE')) throw error
      }
    }
    throw new Error('could not allocate a unique run id')
  }

  getRun(id: string): RunRecord | null {
    const row = this.db
      .query('SELECT * FROM runs WHERE id = ?')
      .get(id) as RunRow | null
    return row ? rowToRecord(row) : null
  }

  /** Persist engine state; the run status mirrors the snapshot's. */
  updateRun(id: string, snapshot: WorkflowSnapshot): void {
    this.db.run(
      `UPDATE runs
       SET status = ?, snapshot_json = ?, updated_at = ?
       WHERE id = ?`,
      [snapshot.status, JSON.stringify(snapshot), Date.now(), id],
    )
  }

  setOwnerLease(id: string, lease: string | null): boolean {
    const result = this.db.run(
      'UPDATE runs SET owner_lease = ?, updated_at = ? WHERE id = ?',
      [lease, Date.now(), id],
    )
    return result.changes > 0
  }

  listRuns(filter: { sessionId?: string; statuses?: readonly RunStatus[] } = {}): RunRecord[] {
    const clauses: string[] = []
    const params: SQLQueryBindings[] = []
    if (filter.sessionId !== undefined) {
      clauses.push('session_id = ?')
      params.push(filter.sessionId)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
      params.push(...filter.statuses)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .query(`SELECT * FROM runs ${where} ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 200`)
      .all(...params) as RunRow[]
    return rows.map(rowToRecord)
  }

  appendEvent(runId: string, type: string, data?: Record<string, unknown>): void {
    this.db.run(
      'INSERT INTO run_events (run_id, at, type, data_json) VALUES (?, ?, ?, ?)',
      [runId, Date.now(), type, data === undefined ? null : JSON.stringify(data)],
    )
  }

  events(runId: string): WorkflowEvent[] {
    const rows = this.db
      .query('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as Array<{
      seq: number
      run_id: string
      at: number
      type: string
      data_json: string | null
    }>
    return rows.map(row => ({
      seq: row.seq,
      runId: row.run_id,
      at: row.at,
      type: row.type,
      data: row.data_json === null ? null : (JSON.parse(row.data_json) as Record<string, unknown>),
    }))
  }
}
