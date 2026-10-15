/**
 * Migration 003 — transcript read-through cache fidelity columns.
 *
 * `messages.role` distinguishes the two entry lists the shared reducer takes:
 * 'main' (the post-boundary buffer — or the whole file for small files) and
 * 'meta' (pre-boundary session-scoped metadata recovered by
 * scanPreBoundaryMetadata). Folding both into one list would change reduction
 * order (the metadata pass must run first so later values overwrite), so the
 * split is stored rather than re-derived at read time.
 *
 * `sessions.synced_path` records WHICH file the synced_size/synced_mtime stat
 * belongs to: the same sessionId can resolve to files in more than one
 * project dir (worktree listings), and size/mtime alone cannot distinguish
 * them. NULL = never synced through the path-aware loader (treated as stale).
 *
 * Default 'main' keeps every pre-existing row valid: the old syncSession
 * stored one flat list, and for small files (the only faithful regime it
 * supported) that list IS the main list.
 */
import type { SqliteDatabase } from '../driver.js'

export const migration003CacheRoles = {
  id: '003-cache-roles',
  version: 3,
  up(db: SqliteDatabase): void {
    db.exec(`
      ALTER TABLE messages ADD COLUMN role TEXT NOT NULL DEFAULT 'main';
      ALTER TABLE sessions ADD COLUMN synced_path TEXT;
    `)
  },
}
