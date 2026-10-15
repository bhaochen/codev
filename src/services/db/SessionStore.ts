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
import { isTranscriptMessage, buildTranscriptShape } from '../../utils/sessionStorage.js'
import type { TranscriptShape } from '../../utils/sessionStorage.js'
import { openDatabaseSync } from './driver.js'
import type { SqliteDatabase, SqlValue } from './driver.js'
import { runMigrations } from './migrations/index.js'
import { extractListingMeta, mergeListingMeta, type ListingMeta } from './listingProjection.js'

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
  syncedSize?: number
  syncedMtime?: number
  syncedPath?: string
}

export interface MessageRow {
  seq: number
  sessionId: string
  uuid: string
  parentUuid: string | null
  entryType: string
  data: Entry
  createdAt: number
  /** Reducer role: 'main' (transcript buffer) or 'meta' (pre-boundary metadata). */
  role: 'main' | 'meta'
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

  private constructor(db: SqliteDatabase) {
    this.db = db
  }

  static open(path: string = defaultStorePath()): SessionStore {
    mkdirSync(dirname(path), { recursive: true })
    // openDatabaseSync applies WAL/PRAGMA and picks bun:sqlite → node:sqlite.
    // This removes the previous hard dependency on bun:sqlite so the store
    // also works on plain Node ≥22.5.
    const db = openDatabaseSync(path)
    runMigrations(db)
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

  /**
   * Execute a function inside a database transaction (BEGIN IMMEDIATE / COMMIT / ROLLBACK).
   * Uses savepoint-based nesting so callers can compose transactions safely.
   * If fn throws, the transaction is rolled back and the error is re-thrown.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /** Test-only: execute raw SQL within a transaction. */
  testOnly_runInTransaction<T>(fn: (db: { run(sql: string, params?: unknown[]): void; query(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] } }) => T): T {
    return this.transaction(() => fn(this.db))
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

  /**
   * Batch-insert entries. `role` preserves the shared reducer's two input
   * lists: 'main' (the transcript buffer) vs 'meta' (pre-boundary
   * session-scoped metadata), so loadTranscript can rebuild both lists in
   * their original order instead of a flattened, reduction-order-destroying
   * single list.
   */
  appendMessages(
    sessionId: string,
    entries: Entry[],
    role: 'main' | 'meta' = 'main',
  ): void {
    const now = Date.now()
    const insertStmt = this.db.prepare(
      `INSERT INTO messages (session_id, uuid, parent_uuid, entry_type, data_json, created_at, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const updateStmt = this.db.prepare(
      'UPDATE sessions SET message_count = message_count + ?, updated_at = ? WHERE id = ?',
    )

    // Use transaction for batch insert
    this.db.transaction(() => {
      for (const entry of entries) {
        const uuid = (entry as { uuid?: string }).uuid ?? crypto.randomUUID()
        const parentUuid = (entry as TranscriptMessage).parentUuid ?? null
        insertStmt.run(sessionId, uuid, parentUuid, entry.type, JSON.stringify(entry), now, role)
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
      role: string | null
    }>

    return rows.map(row => ({
      seq: row.seq,
      sessionId: row.session_id,
      uuid: row.uuid,
      parentUuid: row.parent_uuid,
      entryType: row.entry_type,
      data: JSON.parse(row.data_json) as Entry,
      createdAt: row.created_at,
      role: row.role === 'meta' ? 'meta' : 'main',
    }))
  }

  getMessageCount(sessionId: string): number {
    const row = this.db
      .query('SELECT message_count FROM sessions WHERE id = ?')
      .get(sessionId) as { message_count: number } | null
    return row?.message_count ?? 0
  }

  /**
   * Look up a single message by its uuid using the idx_messages_uuid index.
   * This is O(log n) via the index — orders of magnitude faster than a full
   * scan of getMessages() for large sessions (the benchmark measured ~366x on
   * a 5000-message session). Use this for parent-uuid resolution and hydration.
   */
  getMessageByUuid(uuid: string): MessageRow | null {
    const row = this.db
      .query('SELECT * FROM messages WHERE uuid = ? LIMIT 1')
      .get(uuid) as
      | {
          seq: number
          session_id: string
          uuid: string
          parent_uuid: string | null
          entry_type: string
          data_json: string
          created_at: number
          role: string | null
        }
      | null
    if (!row) return null
    return {
      seq: row.seq,
      sessionId: row.session_id,
      uuid: row.uuid,
      parentUuid: row.parent_uuid,
      entryType: row.entry_type,
      data: JSON.parse(row.data_json) as Entry,
      createdAt: row.created_at,
      role: row.role === 'meta' ? 'meta' : 'main',
    }
  }

  /**
   * D1/D3: mark the session's rows as authoritative (primary-written). While
   * marked, reads serve the rows without the file-freshness resync — the
   * export file may lag (or be missing) and must never roll rows back.
   * Unmarked rows keep the shadow semantics (freshness-gated, file-anchored),
   * which is also what lets pre-v4 legacy rows self-heal by resyncing from
   * the file once before being adopted.
   */
  markSessionPrimaryOwned(sessionId: string): void {
    const row = this.getSession(sessionId)
    if (!row) return
    const meta = (row.metadata ?? {}) as Record<string, unknown>
    if (meta.__primary === true) return
    this.updateSession(sessionId, { metadata: { ...meta, __primary: true } })
  }

  /** Whether the session's rows have been primary-written (see above). */
  isSessionPrimaryOwned(sessionId: string): boolean {
    const row = this.getSession(sessionId)
    return (row?.metadata as Record<string, unknown> | undefined)?.__primary === true
  }

  /**
   * uuid of a session's last row (by seq), or null when the session has no
   * rows. The shadow writer uses this as an optimistic-lock token: if the
   * last row is not the one this writer left, another writer (or a reader's
   * resync) touched the session and incremental appends must not proceed.
   */
  getLastMessageUuid(sessionId: string): string | null {
    const row = this.db
      .query('SELECT uuid FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
      .get(sessionId) as { uuid: string } | null
    return row?.uuid ?? null
  }

  // =========================================================================
  // Transcript Store (SQLite-backed, shared reducer)
  // =========================================================================

  /**
   * Ensure a session row exists (idempotent). Required before appendMessages,
   * which references sessions(id) via FK and updates its message_count.
   */
  ensureSession(sessionId: string, projectDir: string): void {
    if (this.getSession(sessionId)) return
    const now = Date.now()
    this.createSession({ id: sessionId, projectDir, createdAt: now, updatedAt: now })
  }

  /**
   * Persist an ordered transcript with FULL fidelity: every entry becomes a row
   * in the messages table, ordered by autoincrement seq (the append-only log
   * order). Unlike migrateFromJsonl — which projects a few metadata kinds into
   * sessions columns and drops the rest — this stores ALL entry types so the
   * transcript can be reconstructed exactly via loadTranscript.
   *
   * Metadata entries (title/tag/agent/etc.) have no uuid; appendMessages
   * synthesizes one for the row's NOT NULL column, but data_json keeps the
   * original entry, so the reducer routes it by entry.type — the synthetic
   * uuid never enters the transcript messages map.
   */
  writeTranscript(sessionId: string, projectDir: string, entries: Entry[]): void {
    this.ensureSession(sessionId, projectDir)
    this.appendMessages(sessionId, entries)
  }

  /**
   * Read a session's full transcript and reduce it to the same TranscriptShape
   * the JSONL path produces. Rows are read in seq order (append-only log order)
   * and split back into the reducer's two input lists by `role` — mainEntries
   * and the pre-boundary metadataEntries whose pass must run first — then fed
   * to the shared buildTranscriptShape reducer, so the SQLite path is
   * guaranteed to agree with loadTranscriptFile (fidelity by construction,
   * not by two copies).
   */
  loadTranscript(sessionId: string): TranscriptShape {
    const rows = this.db
      .query('SELECT data_json, role FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Array<{ data_json: string; role: string }>
    const mainEntries: Entry[] = []
    const metadataEntries: Entry[] = []
    for (const row of rows) {
      const entry = JSON.parse(row.data_json) as Entry
      if (row.role === 'meta') metadataEntries.push(entry)
      else mainEntries.push(entry)
    }
    return buildTranscriptShape(mainEntries, metadataEntries)
  }

  /**
   * Byte size + mtime + source path this session was last synced from.
   * NULL (or a NULL path — rows written before migration 003) = never synced
   * through the path-aware loader; the read-through loader treats that as
   * stale. The path participates in freshness because one sessionId can
   * resolve to files in different project dirs (worktree listings), and
   * size/mtime alone cannot tell those apart.
   */
  getSyncInfo(sessionId: string): { size: number; mtime: number; path: string } | null {
    const row = this.db
      .query('SELECT synced_size, synced_mtime, synced_path FROM sessions WHERE id = ?')
      .get(sessionId) as {
      synced_size: number | null
      synced_mtime: number | null
      synced_path: string | null
    } | null
    if (
      !row ||
      row.synced_size == null ||
      row.synced_mtime == null ||
      row.synced_path == null
    )
      return null
    return { size: row.synced_size, mtime: row.synced_mtime, path: row.synced_path }
  }

  /** Record the JSONL stat this session was synced at (post-sync freshness mark). */
  setSyncInfo(sessionId: string, size: number, mtime: number, path: string): void {
    this.db.run(
      'UPDATE sessions SET synced_size = ?, synced_mtime = ?, synced_path = ? WHERE id = ?',
      [size, mtime, path, sessionId],
    )
  }

  /**
   * Rebuild a session's SQLite mirror from the parsed JSONL entry lists.
   * Full fidelity: stores EVERY entry — not just transcript messages + summary
   * — in its reducer role: `entries` (main buffer) as role 'main' and
   * `preBoundaryMeta` (session-scoped metadata recovered from before the
   * compact boundary) as role 'meta', so loadTranscript feeds the reducer the
   * same two lists in the same pass order loadTranscriptFile does. Also
   * projects session-list metadata (title/tag/agent) into the sessions row
   * for efficient listing and extracts createdAt from the first entry.
   *
   * Idempotent: REPLACES any existing rows for the session (unlike
   * writeTranscript, which appends). This is the canonical "make SQLite match
   * the source" operation used by migration and sync-on-load — unlike the old
   * migrateFromJsonl/migrateSession path, which dropped every non-transcript
   * entry type and produced an incomplete mirror.
   *
   * Non-transactional across the DELETE+rebuild boundary by design: a crash
   * mid-sync leaves synced_path NULL (setSyncInfo runs after this returns),
   * so the next read re-syncs rather than trusting partial rows.
   */
  syncSession(
    sessionId: string,
    projectDir: string,
    entries: Entry[],
    preBoundaryMeta: Entry[] = [],
  ): number {
    // Project listing metadata over [pre-boundary meta, main] — the same
    // order the reducer's two passes apply (metadata pass first, main
    // overwrites). Column projections (title/tag/agent) keep their prior
    // last-wins semantics; the rest lands in metadata_json so the picker can
    // serve enriched listings without reading the JSONL head/tail.
    const all = [...preBoundaryMeta, ...entries]
    const listing = extractListingMeta(all)
    const firstOfAll = preBoundaryMeta[0] ?? entries[0]
    const firstTimestamp = (firstOfAll as { timestamp?: string } | undefined)?.timestamp
    const parsed = firstTimestamp ? new Date(firstTimestamp).getTime() : NaN
    // A malformed timestamp must not crash the sync (and must not store NaN).
    const createdAt = Number.isFinite(parsed) ? parsed : Date.now()
    const now = Date.now()

    this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
    this.createSession({
      id: sessionId,
      projectDir,
      title: listing.customTitle,
      tag: listing.tag,
      agentName: listing.agentName,
      agentColor: listing.agentColor,
      createdAt,
      updatedAt: now,
      metadata: listing as Record<string, unknown>,
    })
    if (preBoundaryMeta.length > 0) this.appendMessages(sessionId, preBoundaryMeta, 'meta')
    if (entries.length > 0) this.appendMessages(sessionId, entries, 'main')
    return entries.length + preBoundaryMeta.length
  }

  /**
   * Incremental listing-metadata update for the shadow writer's fast path.
   * Merges the batch's listing projection into the session row (last-wins,
   * first-wins for head-semantics fields) and keeps the title/tag/agent
   * columns in step. Called in the same transaction as the message appends.
   */
  mergeSessionListingMeta(sessionId: string, entries: readonly Entry[]): void {
    if (entries.length === 0) return
    const row = this.getSession(sessionId)
    if (!row) return
    const patch = extractListingMeta(entries)
    const existing = (row.metadata ?? {}) as ListingMeta
    const merged = mergeListingMeta(existing, patch)

    const updates: Parameters<SessionStore['updateSession']>[1] = {
      metadata: merged as Record<string, unknown>,
    }
    if (patch.customTitle !== undefined) updates.title = patch.customTitle
    if (patch.tag !== undefined) updates.tag = patch.tag
    if (patch.agentName !== undefined) updates.agentName = patch.agentName
    if (patch.agentColor !== undefined) updates.agentColor = patch.agentColor
    this.updateSession(sessionId, updates)
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
   * Fraction of allocated pages that are on the freelist (0..1). A delete
   * without VACUUM leaves pages on the freelist: the file does not shrink and
   * the space is only available for reuse. Used to decide when an automatic
   * vacuum is worthwhile (e.g. after a large prune from an old migration bug).
   */
  freelistRatio(): number {
    const pageCount = Object.values(
      this.db.query('PRAGMA page_count').get() as { page_count: number },
    )[0] as number
    if (!pageCount) return 0
    const freelist = Object.values(
      this.db.query('PRAGMA freelist_count').get() as { freelist_count: number },
    )[0] as number
    return freelist / pageCount
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
    syncedSize: row.synced_size as number | undefined,
    syncedMtime: row.synced_mtime as number | undefined,
    syncedPath: row.synced_path as string | undefined,
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

/**
 * Test-only: drop the singleton so the next getSessionStore() re-opens with
 * the current environment (tests that redirect CLAUDE_CONFIG_DIR per test
 * would otherwise keep the first test's database).
 */
export function __resetSessionStoreForTests(): void {
  if (instance) {
    try {
      instance.close()
    } catch {
      // already closed
    }
    instance = null
  }
}
