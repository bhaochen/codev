/**
 * Migration registry + runner.
 *
 * Migrations run in ascending `version` order, each idempotently gated by the
 * `migrations` table (id = migration id). Each migration runs inside a single
 * transaction and is recorded atomically, so a crash mid-migration never
 * leaves a half-applied schema.
 *
 * Adding a migration:
 *   1. Create `NNN-name.ts` exporting `{ id, version, up(db) }`.
 *   2. Append it to MIGRATIONS below (order by version).
 * Never edit an already-shipped migration — add a new one instead.
 */
import type { SqliteDatabase } from '../driver.js'
import { migration001Initial } from './001-initial.js'
import { migration002SyncColumns } from './002-sync-columns.js'
import { migration003CacheRoles } from './003-cache-roles.js'
import { migration004SubagentSessions } from './004-subagent-sessions.js'
import { migration005SessionActivity } from './005-session-activity.js'
import { migration006PendingNotifications } from './006-pending-notifications.js'
import { migration007BackgroundTasks } from './007-background-tasks.js'

export interface Migration {
  id: string
  version: number
  up(db: SqliteDatabase): void
}

/** Ordered registry — ascending version. */
export const MIGRATIONS: readonly Migration[] = [
  migration001Initial,
  migration002SyncColumns,
  migration003CacheRoles,
  migration004SubagentSessions,
  migration005SessionActivity,
  migration006PendingNotifications,
  migration007BackgroundTasks,
]

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
}

/**
 * Apply all pending migrations. Safe to call on every open — it is a no-op
 * once the DB is up to date. Returns the ids of migrations applied this call.
 */
export function runMigrations(db: SqliteDatabase): string[] {
  ensureMigrationsTable(db)

  const appliedRows = db.query('SELECT id FROM migrations').all() as Array<{ id: string }>
  const applied = new Set(appliedRows.map(r => r.id))

  // Sort a copy by version so we never depend on registry array order alone.
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version)

  const newlyApplied: string[] = []
  for (const migration of ordered) {
    if (applied.has(migration.id)) continue

    // Run the migration + its version record in one transaction so schema and
    // bookkeeping stay consistent even if the process dies mid-write.
    db.transaction(() => {
      migration.up(db)
      db.run('INSERT INTO migrations (id, applied_at) VALUES (?, ?)', [migration.id, Date.now()])
    })()
    newlyApplied.push(migration.id)
  }

  return newlyApplied
}

/** Highest applied migration version (0 if none). */
export function currentSchemaVersion(db: SqliteDatabase): number {
  ensureMigrationsTable(db)
  const rows = db.query('SELECT id FROM migrations').all() as Array<{ id: string }>
  const appliedIds = new Set(rows.map(r => r.id))
  let max = 0
  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id) && m.version > max) max = m.version
  }
  return max
}
