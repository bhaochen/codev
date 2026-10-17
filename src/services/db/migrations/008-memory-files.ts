/**
 * Migration 008 — memory file mirror.
 *
 * Auto-memory (MEMORY.md + topic files + daily logs) is written by the agent
 * through the standard file tools directly into
 * `<configHome>/projects/<project>/memory/` — there is no harness write seam
 * to funnel through (unlike transcripts, which all land in sessionStorage).
 * The files are therefore mirrored into SQLite by a best-effort sync
 * (see services/db/memoryMirror.ts) so the projects tree can be wiped or
 * lost without losing memory: the mirror restores the directory whenever the
 * harness next touches it.
 *
 * Layout: one row per file, keyed by a `scope` (the projects-dir name for
 * the default layout, else a sanitized absolute path) plus the path relative
 * to the memory dir (POSIX separators). Content is utf-8 text.
 */
import type { SqliteDatabase } from '../driver.js'

export const migration008MemoryFiles = {
  id: '008-memory-files',
  version: 8,
  up(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_files (
        scope TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_files_scope
        ON memory_files(scope);
    `)
  },
}
