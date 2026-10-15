/**
 * Migration 004 — subagent transcript mirroring.
 *
 * Subagent transcripts (`<project>/<parentSessionId>/subagents/agent-*.jsonl`)
 * get their own rows, keyed by the same composite relative-path convention
 * the migration scanner uses (`<parentSessionId>/subagents/agent-<agentId>`,
 * optionally nested under subagent subdirectories). The new columns:
 *
 *   - `kind`: 'main' (user sessions) or 'subagent' (sidechain transcripts).
 *     Pickers/listings filter to 'main'; subagent reads (getAgentTranscript)
 *     look rows up by composite id.
 *   - `parent_session_id`: the session that spawned the subagent — lets
 *     cleanup/forensics trace rows back without parsing the id.
 *
 * Defaults keep every pre-existing row valid ('main', NULL parent).
 */
import type { SqliteDatabase } from '../driver.js'

export const migration004SubagentSessions = {
  id: '004-subagent-sessions',
  version: 4,
  up(db: SqliteDatabase): void {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'main';
      ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_sessions_kind ON sessions(kind);
      CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    `)
  },
}
