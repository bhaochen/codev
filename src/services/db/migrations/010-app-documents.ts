import type { SqliteDatabase } from '../driver.js'

/** Durable mirrors for small structured app documents (global config, etc.). */
export const migration010AppDocuments = {
  id: '010-app-documents',
  version: 10,
  up(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_documents (
        namespace TEXT NOT NULL,
        document_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, document_key)
      );
      CREATE INDEX IF NOT EXISTS idx_app_documents_updated
        ON app_documents(updated_at);
    `)
  },
}
