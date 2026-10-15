/**
 * SessionStore — SQLite-backed session/message persistence.
 *
 * Replaces JSONL file-based session storage with SQLite for:
 * - Indexed message retrieval (no full-file scan)
 * - Transactional writes (crash-safe)
 * - Efficient pagination for large sessions
 * - Better concurrent read performance (WAL mode)
 *
 * Schema inspired by opencode's session_v2 + session_message tables,
 * adapted for codev's Entry-based JSONL format.
 *
 * Migration: Existing JSONL files are migrated on first access.
 * The JSONL file is kept as backup until migration is verified.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UUID } from 'crypto'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import { isTranscriptMessage } from '../../utils/sessionStorage.js'
import { parseJSONL } from '../../utils/json.js'
import { logForDebugging } from '../../utils/debug.js'
import { openDatabaseSync } from './driver.js'
import type { SqliteDatabase, SqlValue } from './driver.js'

// ============================================================================
// Schema
// ============================================================================

const SCHEMA = `
-- Session metadata table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  title TEXT,
  tag TEXT,
  agent_id TEXT,
  agent_name TEXT,
  agent_color TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- Messages table (append-only, ordered by seq)
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  uuid TEXT NOT NULL,
  parent_uuid TEXT,
  entry_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(uuid);

-- Migration tracking
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`

// ============================================================================
// Types
// ============================================================================

export interface SessionMeta {
  id: string
  projectDir: string
  title?: string
  tag?: string
  agentId?: string
  agentName?: string
  agentColor?: string
  model?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  metadata?: Record<string, unknown>
}

export interface MessageRow {
  seq: number
  sessionId: string
  uuid: string
  parentUuid: string | null
  entryType: string
  data: Entry
  createdAt: number
}

export interface SessionListOptions {
  projectDir?: string
  limit?: number
  offset?: number
  orderBy?: 'updated' | 'created'
}

export interface MessageQueryOptions {
  sessionId: string
  limit?: number
  beforeSeq?: number
  afterSeq?: number
  entryTypes?: string[]
}

// ============================================================================
// Session Store
// ============================================================================

export class SessionStore {
  private readonly db: SqliteDatabase
  private migratedSessions = new Set<string>()

  private constructor(db: SqliteDatabase) {
    this.db = db
  }

  static open(path: string = defaultStorePath()): SessionStore {
    mkdirSync(dirname(path), { recursive: true })
    // openDatabaseSync applies WAL/PRAGMA and picks bun:sqlite → node:sqlite.
    // This removes the previous hard dependency on bun:sqlite so the store
    // also works on plain Node ≥22.5.
    const db = openDatabaseSync(path)
    db.exec(SCHEMA)
    return new SessionStore(db)
  }

  close(): void {
    this.db.close()
  }

  // =========================================================================
  // Session CRUD
  // =========================================================================

  createSession(meta: Omit<SessionMeta, 'messageCount'>): void {
    const now = Date.now()
    this.db.run(
      `INSERT INTO sessions (id, project_dir, title, tag, agent_id, agent_name, agent_color, model, created_at, updated_at, message_count, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        meta.id,
        meta.projectDir,
        meta.title ?? null,
        meta.tag ?? null,
        meta.agentId ?? null,
        meta.agentName ?? null,
        meta.agentColor ?? null,
        meta.model ?? null,
        meta.createdAt,
        meta.updatedAt,
        meta.metadata ? JSON.stringify(meta.metadata) : null,
      ],
    )
  }

  getSession(id: string): SessionMeta | null {
    const row = this.db
      .query('SELECT * FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | null
    return row ? rowToSessionMeta(row) : null
  }

  updateSession(id: string, updates: Partial<Pick<SessionMeta, 'title' | 'tag' | 'agentId' | 'agentName' | 'agentColor' | 'model' | 'metadata'>>): void {
    const sets: string[] = ['updated_at = ?']
    const params: SqlValue[] = [Date.now()]

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title) }
    if (updates.tag !== undefined) { sets.push('tag = ?'); params.push(updates.tag) }
    if (updates.agentId !== undefined) { sets.push('agent_id = ?'); params.push(updates.agentId) }
    if (updates.agentName !== undefined) { sets.push('agent_name = ?'); params.push(updates.agentName) }
    if (updates.agentColor !== undefined) { sets.push('agent_color = ?'); params.push(updates.agentColor) }
    if (updates.model !== undefined) { sets.push('model = ?'); params.push(updates.model) }
    if (updates.metadata !== undefined) { sets.push('metadata_json = ?'); params.push(JSON.stringify(updates.metadata)) }

    params.push(id)
    this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  listSessions(options: SessionListOptions = {}): SessionMeta[] {
    const clauses: string[] = []
    const params: SqlValue[] = []

    if (options.projectDir) {
      clauses.push('project_dir = ?')
      params.push(options.projectDir)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const orderCol = options.orderBy === 'created' ? 'created_at' : 'updated_at'
    const limit = options.limit ?? 100
    const offset = options.offset ?? 0

    const rows = this.db
      .query(`SELECT * FROM sessions ${where} ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[]

    return rows.map(rowToSessionMeta)
  }

  deleteSession(id: string): void {
    this.db.run('DELETE FROM messages WHERE session_id = ?', [id])
    this.db.run('DELETE FROM sessions WHERE id = ?', [id])
  }

  // =========================================================================
  // Message Operations
  // =========================================================================

  appendMessage(sessionId: string, entry: Entry): void {
    const now = Date.now()
    const uuid = (entry as { uuid?: string }).uuid ?? crypto.randomUUID()
    const parentUuid = (entry as TranscriptMessage).parentUuid ?? null
    const entryType = entry.type

    this.db.run(
      `INSERT INTO messages (session_id, uuid, parent_uuid, entry_type, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, uuid, parentUuid, entryType, JSON.stringify(entry), now],
    )

    // Update message count
    this.db.run(
      'UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?',
      [now, sessionId],
    )
  }

  appendMessages(sessionId: string, entries: Entry[]): void {
    const now = Date.now()
    const insertStmt = this.db.prepare(
      `INSERT INTO messages (session_id, uuid, parent_uuid, entry_type, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const updateStmt = this.db.prepare(
      'UPDATE sessions SET message_count = message_count + ?, updated_at = ? WHERE id = ?',
    )

    // Use transaction for batch insert
    this.db.transaction(() => {
      for (const entry of entries) {
        const uuid = (entry as { uuid?: string }).uuid ?? crypto.randomUUID()
        const parentUuid = (entry as TranscriptMessage).parentUuid ?? null
        insertStmt.run(sessionId, uuid, parentUuid, entry.type, JSON.stringify(entry), now)
      }
      updateStmt.run(entries.length, now, sessionId)
    })()
  }

  getMessages(options: MessageQueryOptions): MessageRow[] {
    const clauses: string[] = ['session_id = ?']
    const params: SqlValue[] = [options.sessionId]

    if (options.beforeSeq !== undefined) {
      clauses.push('seq < ?')
      params.push(options.beforeSeq)
    }
    if (options.afterSeq !== undefined) {
      clauses.push('seq > ?')
      params.push(options.afterSeq)
    }
    if (options.entryTypes && options.entryTypes.length > 0) {
      clauses.push(`entry_type IN (${options.entryTypes.map(() => '?').join(', ')})`)
      params.push(...options.entryTypes)
    }

    const where = clauses.join(' AND ')
    const limit = options.limit ?? 1000

    const rows = this.db
      .query(`SELECT * FROM messages WHERE ${where} ORDER BY seq ASC LIMIT ?`)
      .all(...params, limit) as Array<{
      seq: number
      session_id: string
      uuid: string
      parent_uuid: string | null
      entry_type: string
      data_json: string
      created_at: number
    }>

    return rows.map(row => ({
      seq: row.seq,
      sessionId: row.session_id,
      uuid: row.uuid,
      parentUuid: row.parent_uuid,
      entryType: row.entry_type,
      data: JSON.parse(row.data_json) as Entry,
      createdAt: row.created_at,
    }))
  }

  getMessageCount(sessionId: string): number {
    const row = this.db
      .query('SELECT message_count FROM sessions WHERE id = ?')
      .get(sessionId) as { message_count: number } | null
    return row?.message_count ?? 0
  }

  // =========================================================================
  // JSONL Migration
  // =========================================================================

  /**
   * Migrate a JSONL session file to SQLite.
   * Reads the JSONL file, inserts all entries, and marks migration complete.
   * The JSONL file is preserved as backup.
   */
  migrateFromJsonl(sessionId: string, jsonlPath: string, projectDir: string): void {
    if (this.migratedSessions.has(sessionId)) return

    logForDebugging(`Migrating session ${sessionId} from ${jsonlPath}`)

    // Check if already migrated
    const existing = this.getSession(sessionId)
    if (existing && existing.messageCount > 0) {
      this.migratedSessions.add(sessionId)
      return
    }

    // Read and parse JSONL file
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const content = readFileSync(jsonlPath, 'utf-8')
    const entries = parseJSONL<Entry>(content)

    if (entries.length === 0) {
      this.migratedSessions.add(sessionId)
      return
    }

    // Extract session metadata from entries
    const firstTimestamp = (entries[0] as { timestamp?: string }).timestamp
    const createdAt = firstTimestamp ? new Date(firstTimestamp).getTime() : Date.now()
    const now = Date.now()

    // Find title/tag/agent metadata
    let title: string | undefined
    let tag: string | undefined
    let agentId: string | undefined
    let agentName: string | undefined
    let agentColor: string | undefined

    for (const entry of entries) {
      if (entry.type === 'custom-title' && !title) title = (entry as { customTitle?: string }).customTitle
      if (entry.type === 'tag' && !tag) tag = (entry as { tag?: string }).tag
      if (entry.type === 'agent-name' && !agentName) agentName = (entry as { agentName?: string }).agentName
      if (entry.type === 'agent-color' && !agentColor) agentColor = (entry as { agentColor?: string }).agentColor
    }

    // Insert session
    this.createSession({
      id: sessionId,
      projectDir,
      title,
      tag,
      agentId,
      agentName,
      agentColor,
      createdAt,
      updatedAt: now,
    })

    // Insert messages in transaction
    this.db.transaction(() => {
      for (const entry of entries) {
        if (isTranscriptMessage(entry) || entry.type === 'summary') {
          this.appendMessage(sessionId, entry)
        }
      }
    })()

    // Record migration
    this.db.run(
      'INSERT OR REPLACE INTO migrations (id, applied_at) VALUES (?, ?)',
      [`session_${sessionId}`, now],
    )

    this.migratedSessions.add(sessionId)
    logForDebugging(`Migrated session ${sessionId}: ${entries.length} entries`)
  }

  // =========================================================================
  // Utility
  // =========================================================================

  /**
   * Get the conversation chain for LLM context (all messages from latest compaction).
   */
  getConversationChain(sessionId: string): TranscriptMessage[] {
    // Find latest compaction boundary
    const compaction = this.db
      .query(
        `SELECT seq FROM messages
         WHERE session_id = ? AND entry_type = 'system'
         AND data_json LIKE '%compact_boundary%'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId) as { seq: number } | null

    const afterSeq = compaction?.seq
    const options: MessageQueryOptions = {
      sessionId,
      entryTypes: ['user', 'assistant', 'attachment', 'system'],
      limit: 10000,
    }
    if (afterSeq !== null) {
      options.afterSeq = afterSeq
    }

    const rows = this.getMessages(options)
    return rows
      .map(r => r.data)
      .filter((e): e is TranscriptMessage => isTranscriptMessage(e))
  }

  /**
   * Vacuum the database (reclaim space after deletions).
   */
  vacuum(): void {
    this.db.exec('VACUUM;')
  }

  /**
   * Get database file size in bytes.
   */
  getDatabaseSize(): number {
    const row = this.db.query('PRAGMA page_count').get() as { page_count: number }
    const pageRow = this.db.query('PRAGMA page_size').get() as { page_size: number }
    return row.page_count * pageRow.page_size
  }
}

// ============================================================================
// Helpers
// ============================================================================

function rowToSessionMeta(row: Record<string, unknown>): SessionMeta {
  return {
    id: row.id as string,
    projectDir: row.project_dir as string,
    title: row.title as string | undefined,
    tag: row.tag as string | undefined,
    agentId: row.agent_id as string | undefined,
    agentName: row.agent_name as string | undefined,
    agentColor: row.agent_color as string | undefined,
    model: row.model as string | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    messageCount: row.message_count as number,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : undefined,
  }
}

function defaultStorePath(): string {
  return join(getClaudeConfigHomeDir(), 'sessions', 'sessions.sqlite')
}

// Singleton instance
let instance: SessionStore | null = null

export function getSessionStore(): SessionStore {
  if (!instance) {
    instance = SessionStore.open()
  }
  return instance
}
