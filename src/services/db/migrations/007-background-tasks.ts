/**
 * Migration 007 — in-flight background task tracking.
 *
 * pending_notifications (006) covers completions that were queued but not
 * delivered. This table covers the other loss mode: tasks that were still
 * RUNNING when the process died. One row per spawned background shell task,
 * written at spawn and deleted at terminal notification (or kill) — so a
 * row surviving a restart means "this was running when we died" and the
 * next launch reports it as interrupted (see utils/task/recovery.ts).
 */
import type { SqliteDatabase } from '../driver.js'

export const migration007BackgroundTasks = {
  id: '007-background-tasks',
  version: 7,
  up(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS background_tasks (
        task_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        session_id TEXT,
        description TEXT,
        kind TEXT,
        output_path TEXT,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_background_tasks_project
        ON background_tasks(project_dir, started_at);
    `)
  },
}
