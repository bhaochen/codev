/**
 * Migration runner tests — verify versioned, idempotent schema application.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabaseSync } from '../driver.js'
import type { SqliteDatabase } from '../driver.js'
import { runMigrations, currentSchemaVersion, MIGRATIONS } from './index.js'
import { migration005SessionActivity } from './005-session-activity.js'

describe('migration runner', () => {
  let db: SqliteDatabase
  let dbPath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'codev-migrations-test-'))
    dbPath = join(dir, 'test.sqlite')
    db = openDatabaseSync(dbPath)
  })

  afterEach(() => {
    db.close()
  })

  it('creates core tables on first run', () => {
    runMigrations(db)
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    expect(names).toContain('sessions')
    expect(names).toContain('messages')
    expect(names).toContain('migrations')
  })

  it('records version and is idempotent on second run', () => {
    const first = runMigrations(db)
    expect(first.length).toBe(MIGRATIONS.length)
    expect(currentSchemaVersion(db)).toBe(Math.max(...MIGRATIONS.map(m => m.version)))

    // Second run applies nothing.
    const second = runMigrations(db)
    expect(second).toEqual([])
  })

  it('persists applied versions across reopen', () => {
    runMigrations(db)
    const version = currentSchemaVersion(db)
    db.close()

    // Reopen the same file — version must be read back from disk.
    const reopened = openDatabaseSync(dbPath)
    try {
      expect(currentSchemaVersion(reopened)).toBe(version)
      expect(runMigrations(reopened)).toEqual([])
    } finally {
      reopened.close()
    }
  })

  it('is safe on a pre-migration DB (tables already exist)', () => {
    // Simulate the old inline-schema DB by creating tables first, no version row.
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, title TEXT, tag TEXT,
        agent_id TEXT, agent_name TEXT, agent_color TEXT, model TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0, metadata_json TEXT
      );
    `)
    // Runner must not throw and must record the baseline version.
    const applied = runMigrations(db)
    expect(applied.length).toBe(MIGRATIONS.length)
    expect(currentSchemaVersion(db)).toBeGreaterThan(0)
  })
})

describe('migration 005 (session activity)', () => {
  let db: SqliteDatabase

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'codev-migrations-005-'))
    db = openDatabaseSync(join(dir, 'test.sqlite'))
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  function insertSession(id: string, updatedAt: number): void {
    db.run(
      `INSERT INTO sessions (id, project_dir, created_at, updated_at, message_count, kind)
       VALUES (?, 'p', ?, ?, 0, 'main')`,
      [id, updatedAt - 1000, updatedAt],
    )
  }

  function insertMessage(id: string, seq: number, timestamp: string | null): void {
    const data = timestamp
      ? JSON.stringify({ type: 'user', timestamp })
      : JSON.stringify({ type: 'tag', tag: '#x' })
    db.run(
      `INSERT INTO messages (seq, session_id, uuid, parent_uuid, entry_type, data_json, created_at, role)
       VALUES (?, ?, ?, NULL, 'user', ?, 0, 'main')`,
      [seq, id, `u-${seq}`, data],
    )
  }

  it('backfills updated_at from the last timestamped entry', () => {
    insertSession('s1', 999_999_999_999)
    insertMessage('s1', 1, '2026-01-01T00:00:00.000Z')
    insertMessage('s1', 2, null) // metadata entry, no timestamp
    insertMessage('s1', 3, '2026-02-02T03:04:05.000Z')

    migration005SessionActivity.up(db)

    const row = db.query('SELECT updated_at FROM sessions WHERE id = ?').get('s1') as {
      updated_at: number
    }
    expect(row.updated_at).toBe(Date.parse('2026-02-02T03:04:05.000Z'))
  })

  it('leaves sessions without timestamped entries untouched', () => {
    insertSession('s2', 123_456)
    insertMessage('s2', 1, null)

    migration005SessionActivity.up(db)

    const row = db.query('SELECT updated_at FROM sessions WHERE id = ?').get('s2') as {
      updated_at: number
    }
    expect(row.updated_at).toBe(123_456)
  })
})
