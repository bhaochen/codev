/**
 * Migration 009 — live session process registry.
 *
 * Replaces the per-PID JSON files in `<configHome>/sessions/<pid>.json`
 * (utils/concurrentSessions.ts) with rows in the shared sessions DB. Same
 * payload as the old files, stored whole in `data_json` so the registry
 * shape can evolve (feature-gated fields) without schema churn. Rows are
 * written at registration, patched in place on updates (name / bridge id /
 * activity / session switch), and deleted on clean exit; crashed sessions'
 * rows are swept by liveness probe on the next count, exactly like the old
 * stale-file sweep.
 */
import type { SqliteDatabase } from '../driver.js'

export const migration009SessionProcesses = {
  id: '009-session-processes',
  version: 9,
  up(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_processes (
        pid INTEGER PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  },
}
