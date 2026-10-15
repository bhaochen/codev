/**
 * Migration 002 — JSONL sync-tracking columns for read-through caching.
 *
 * Adds the byte-offset / mtime a session was last synced from its JSONL source.
 * The read-through transcript loader compares the live file's stat against
 * these to decide whether SQLite is fresh (serve directly), grew by append
 * (sync just the delta), or was compacted / rewritten (full re-sync).
 *
 * NULL synced_size = never synced → the loader performs a full sync on first
 * read. Idempotent via IF NOT EXISTS (safe against pre-migration DBs).
 */
import type { SqliteDatabase } from '../driver.js'

export const migration002SyncColumns = {
  id: '002-sync-columns',
  version: 2,
  up(db: SqliteDatabase): void {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN synced_size INTEGER;
      ALTER TABLE sessions ADD COLUMN synced_mtime INTEGER;
    `)
  },
}
