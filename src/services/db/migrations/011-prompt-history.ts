import type { SqliteDatabase } from '../driver.js'

export const migration011PromptHistory = {
  id: '011-prompt-history',
  version: 11,
  up(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        project TEXT NOT NULL,
        session_id TEXT,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_history_project_time
        ON prompt_history(project, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_history_session_time
        ON prompt_history(session_id, timestamp DESC);
    `)
  },
}
