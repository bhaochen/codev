/**
 * Migration 005 — session activity timestamp.
 *
 * `sessions.updated_at` began as a row write stamp: `syncSession` rebuilt the
 * mirror and `appendMessages` stamped every row with `Date.now()`, so every
 * session migrated in one run shared the run's wall-clock time. Listings order
 * by this column, and under DB-primary + deferred export (D4) it is the only
 * activity signal left once the JSONL tree is dropped — a run-wide value makes
 * /resume recency ordering arbitrary.
 *
 * Backfill from the last timestamped transcript entry (the session's true last
 * activity). Sessions with no timestamped entries keep their current value.
 */
import type { SqliteDatabase } from '../driver.js'

export const migration005SessionActivity = {
  id: '005-session-activity',
  version: 5,
  up(db: SqliteDatabase): void {
    db.exec(`
      UPDATE sessions SET updated_at = (
        SELECT CAST(strftime('%s', json_extract(m.data_json, '$.timestamp')) AS INTEGER) * 1000
        FROM messages m
        WHERE m.session_id = sessions.id
          AND json_extract(m.data_json, '$.timestamp') IS NOT NULL
        ORDER BY m.seq DESC LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1 FROM messages m2
        WHERE m2.session_id = sessions.id
          AND json_extract(m2.data_json, '$.timestamp') IS NOT NULL
      );
    `)
  },
}
