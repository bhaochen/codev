/**
 * Migration 006 — durable pending notifications.
 *
 * Task notifications (background shell/agent completions) live in an
 * in-memory command queue, so a crash or TUI restart silently drops them
 * and the model never learns the task finished. This table mirrors queued
 * `task-notification` commands so the next interactive launch of the same
 * project can replay them (see utils/messageQueueManager.ts
 * restorePendingNotifications).
 *
 * Rows are written on enqueue and deleted on delivery — the table only
 * ever holds notifications that have not reached the model yet. Writes are
 * INSERT OR IGNORE keyed by the notification uuid, so producer retries and
 * queue replays are idempotent.
 */
import type { SqliteDatabase } from '../driver.js'

export const migration006PendingNotifications = {
  id: '006-pending-notifications',
  version: 6,
  up(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_notifications (
        uuid TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        session_id TEXT,
        mode TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id TEXT,
        is_meta INTEGER NOT NULL DEFAULT 0,
        value TEXT NOT NULL,
        origin_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_notifications_project
        ON pending_notifications(project_dir, created_at);
    `)
  },
}
