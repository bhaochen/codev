/**
 * Migration 001 — initial schema.
 *
 * This is the baseline that matches the original inline SCHEMA. It uses
 * IF NOT EXISTS so it is safe to run against a DB that already has these
 * tables (the pre-migration SessionStore created them inline). Existing DBs
 * get this version recorded so future migrations (002+) gate correctly, while
 * structurally changing nothing.
 */
import type { SqliteDatabase } from '../driver.js'

export const migration001Initial = {
  id: '001-initial',
  version: 1,
  up(db: SqliteDatabase): void {
    db.exec(`
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
    `)
  },
}
