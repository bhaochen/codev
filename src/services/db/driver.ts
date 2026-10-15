/**
 * SQLite driver abstraction — P5 adapter chain.
 *
 * SessionStore and the repos below must not depend on a single runtime's
 * SQLite binding. This module probes for a usable driver at runtime and
 * normalizes the three candidates (bun:sqlite, node:sqlite, sql.js) behind
 * one small synchronous surface, so callers never branch on the backend.
 *
 * Probe order (per 9router's proven chain, with one correction):
 *   Bun :  bun:sqlite  → sql.js
 *   Node:  node:sqlite (≥22.5) → sql.js
 *
 * We deliberately do NOT probe better-sqlite3: it is a native addon that
 * SIGSEGVs the whole process on Node >= 24 (a crash try/catch cannot catch),
 * and node:sqlite already covers every supported Node. Adding an optional
 * native dep for a case the stdlib handles is pure downside.
 *
 * Two entry points because sql.js needs async WASM init but the primary
 * consumers are synchronous:
 *   - `openDatabaseSync(path)`  sync probe: bun:sqlite → node:sqlite.
 *     Works everywhere codev actually runs today. Throws if neither exists.
 *   - `async openDatabase(path)`  tries the sync path first, then falls back
 *     to sql.js (async init). Repos / async callers should prefer this.
 *
 * The returned handle is the minimal synchronous surface the repos use:
 *   { driver, run, query().get/.all, exec, prepare().run, transaction, close }
 * `transaction(fn)` returns a callable that runs fn inside BEGIN/COMMIT,
 * matching bun:sqlite's `db.transaction(fn)()` idiom so existing call sites
 * keep working unchanged.
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { logForDebugging } from '../../utils/debug.js'

export type SqlValue = string | number | bigint | null | Uint8Array

export interface StatementLike {
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
  run(...params: SqlValue[]): void
}

export interface SqliteDatabase {
  /** Which backend backs this handle. */
  readonly driver: 'bun-sqlite' | 'node-sqlite' | 'sqljs'
  run(sql: string, params?: SqlValue[]): void
  query(sql: string): StatementLike
  exec(sql: string): void
  prepare(sql: string): StatementLike
  transaction<T>(fn: () => T): () => T
  close(): void
}

/** PRAGMAs applied to native file-backed backends (WAL, durability, cache). */
const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -64000;
`

const require_ = createRequire(import.meta.url)

// ─────────────────────────────────────────────────────────────────────────────
// Shared: savepoint-based transaction for backends without db.transaction().
// Nesting-safe: outermost uses BEGIN IMMEDIATE / COMMIT, inner uses SAVEPOINT.
// ─────────────────────────────────────────────────────────────────────────────
function makeTransaction(db: Omit<SqliteDatabase, 'transaction'>): <T>(fn: () => T) => () => T {
  let depth = 0
  return <T>(fn: () => T) => () => {
    const outer = depth === 0
    const name = `sp_${depth}`
    if (outer) db.exec('BEGIN IMMEDIATE')
    else db.exec(`SAVEPOINT ${name}`)
    depth++
    try {
      const result = fn()
      depth--
      if (outer) db.exec('COMMIT')
      else db.exec(`RELEASE ${name}`)
      return result
    } catch (err) {
      depth--
      if (outer) db.exec('ROLLBACK')
      else db.exec(`ROLLBACK TO ${name}`)
      throw err
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// bun:sqlite
// ─────────────────────────────────────────────────────────────────────────────
function tryBunSqlite(path: string): SqliteDatabase | null {
  if (typeof Bun === 'undefined') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require_('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(path, { create: true })
    db.exec(PRAGMA_SQL)
    return {
      driver: 'bun-sqlite',
      run: (sql, params = []) => {
        db.run(sql, params as never[])
      },
      query: sql => {
        const stmt = db.query(sql)
        return {
          get: (...p) => stmt.get(...(p as never[])) as unknown,
          all: (...p) => stmt.all(...(p as never[])) as unknown[],
          run: (...p) => {
            stmt.run(...(p as never[]))
          },
        }
      },
      exec: sql => {
        db.exec(sql)
      },
      prepare: sql => {
        const stmt = db.prepare(sql)
        return {
          get: (...p) => stmt.get(...(p as never[])) as unknown,
          all: (...p) => stmt.all(...(p as never[])) as unknown[],
          run: (...p) => {
            stmt.run(...(p as never[]))
          },
        }
      },
      transaction: db.transaction.bind(db) as <T>(fn: () => T) => () => T,
      close: () => {
        db.close()
      },
    }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// node:sqlite (Node ≥ 22.5). DatabaseSync has exec/prepare but no run(),
// query(), or transaction(); we synthesize all three.
// ─────────────────────────────────────────────────────────────────────────────
function tryNodeSqlite(path: string): SqliteDatabase | null {
  if (process.versions.bun) return null // Bun handled above; node:sqlite may be absent
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const nodeMinor = Number(process.versions.node.split('.')[1])
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5)) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require_('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(path, { open: true })
    db.exec(PRAGMA_SQL)

    const run = (sql: string, params: SqlValue[] = []) => {
      db.prepare(sql).run(...(params as never[]))
    }
    const query = (sql: string): StatementLike => {
      const stmt = db.prepare(sql)
      return {
        get: (...p) => stmt.get(...(p as never[])) as unknown,
        all: (...p) => stmt.all(...(p as never[])) as unknown[],
        run: (...p) => {
          stmt.run(...(p as never[]))
        },
      }
    }

    const base: Omit<SqliteDatabase, 'transaction'> = {
      driver: 'node-sqlite',
      run,
      query,
      exec: sql => {
        db.exec(sql)
      },
      prepare: sql => {
        const stmt = db.prepare(sql)
        return {
          get: (...p) => stmt.get(...(p as never[])) as unknown,
          all: (...p) => stmt.all(...(p as never[])) as unknown[],
          run: (...p) => {
            stmt.run(...(p as never[]))
          },
        }
      },
      close: () => {
        db.close()
      },
    }
    return { ...base, transaction: makeTransaction(base) }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sql.js — last-resort in-memory fallback (async WASM init).
// Correctness over speed: every mutation marks the DB dirty; we flush the
// exported bytes to disk on transaction commit and on close. Individual
// run() calls outside a transaction are persisted on close (documented
// tradeoff — sql.js is only reached when no native driver exists).
// ─────────────────────────────────────────────────────────────────────────────
async function trySqlJs(path: string): Promise<SqliteDatabase | null> {
  // Minimal structural types for sql.js to avoid a hard dependency on its
  // type defs (sql.js is an optional runtime fallback only).
  interface SqlJsStatement {
    bind(params?: unknown[]): boolean
    step(): boolean
    get(): unknown[]
    getAsObject(): Record<string, unknown>
    free(): void
  }
  interface SqlJsDatabase {
    prepare(sql: string): SqlJsStatement
    run(sql: string, params?: unknown[]): void
    exec(sql: string): unknown[]
    export(): Uint8Array
    close(): void
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const initSqlJs = require_('sql.js') as (
      cfg?: Record<string, unknown>,
    ) => Promise<{ Database: new (data?: Uint8Array) => SqlJsDatabase }>
    const SQL = await initSqlJs()
    const data = existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined
    const db = new SQL.Database(data)
    let dirty = false
    const flush = (): void => {
      if (!dirty) return
      writeFileSync(path, Buffer.from(db.export()), { mode: 0o600 })
      dirty = false
    }

    const runStmt = (sql: string, params: SqlValue[]): unknown => {
      const stmt = db.prepare(sql)
      try {
        if (params.length > 0) stmt.bind(params as never[])
        if (stmt.step()) return stmt.getAsObject()
        return undefined
      } finally {
        stmt.free()
      }
    }

    const base: Omit<SqliteDatabase, 'transaction'> = {
      driver: 'sqljs',
      run: (sql, params = []) => {
        if (params.length === 0) {
          db.run(sql)
        } else {
          runStmt(sql, params)
        }
        dirty = true
      },
      query: (sql: string): StatementLike => ({
        get: (...p) => runStmt(sql, p) as unknown,
        all: (...p) => {
          const stmt = db.prepare(sql)
          const rows: unknown[] = []
          try {
            if (p.length > 0) stmt.bind(p as never[])
            while (stmt.step()) rows.push(stmt.getAsObject())
            return rows
          } finally {
            stmt.free()
          }
        },
        run: (...p) => {
          runStmt(sql, p)
          dirty = true
        },
      }),
      exec: sql => {
        db.run(sql)
        dirty = true
      },
      prepare: (sql: string): StatementLike => ({
        get: (...p) => runStmt(sql, p) as unknown,
        all: (...p) => {
          const stmt = db.prepare(sql)
          const rows: unknown[] = []
          try {
            if (p.length > 0) stmt.bind(p as never[])
            while (stmt.step()) rows.push(stmt.getAsObject())
            return rows
          } finally {
            stmt.free()
          }
        },
        run: (...p) => {
          runStmt(sql, p)
          dirty = true
        },
      }),
      close: () => {
        flush()
        db.close()
      },
    }

    const withFlush = (t: <T>(fn: () => T) => () => T): <T>(fn: () => T) => () => T => fn => () => {
      const result = t(fn)()
      flush()
      return result
    }
    return { ...base, transaction: withFlush(makeTransaction(base)) }
  } catch (err) {
    logForDebugging(`sql.js fallback unavailable: ${String(err)}`, { level: 'debug' })
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────
export function openDatabaseSync(path: string): SqliteDatabase {
  const bun = tryBunSqlite(path)
  if (bun) return bun
  const node = tryNodeSqlite(path)
  if (node) return node
  throw new Error(
    `No synchronous SQLite driver available (bun:sqlite and node:sqlite both failed). ` +
      `Use async openDatabase() to allow the sql.js fallback.`,
  )
}

export async function openDatabase(path: string): Promise<SqliteDatabase> {
  try {
    return openDatabaseSync(path)
  } catch {
    const sqljs = await trySqlJs(path)
    if (sqljs) return sqljs
    throw new Error(`No SQLite driver available (bun:sqlite, node:sqlite, sql.js all failed)`)
  }
}

/** Which driver would openDatabaseSync pick right now (null if none). */
export function currentDriver(): SqliteDatabase['driver'] | null {
  try {
    // Probe a throwaway in-memory path to avoid touching a real file.
    return openDatabaseSync(':memory:').driver
  } catch {
    return null
  }
}
