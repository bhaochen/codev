/**
 * DB → JSONL export / repair.
 *
 * The inverse of the read-through sync: reconstruct a session's JSONL file
 * from its SQLite rows. Two uses:
 *
 *   1. Repair — the export file is lagging or lost (crashed mid-write, the
 *      file was deleted while rows survived, the DB-primary "DB leads"
 *      window). The rewrite makes the file parse back to exactly the
 *      canonical view.
 *   2. Backup/portability — write a session (or all sessions) somewhere else
 *      for external tools.
 *
 * Layout: pre-boundary metadata rows (role 'meta') are written first, then
 * the main rows in seq order. A fresh parse recovers the same two lists:
 * small files reduce everything in order; large files truncate at the last
 * boundary and recover [0, boundary) session metadata by byte scan — the meta
 * rows sit exactly where that scan expects them.
 *
 * After a repair of the canonical path, sync info is refreshed so readers
 * immediately trust the rewritten file.
 */
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { SessionStore } from './SessionStore.js'

export type ExportResult = {
  sessionId: string
  targetPath: string
  entries: number
  /** True when the canonical session file was rewritten (sync info refreshed). */
  repairedCanonical: boolean
}

/**
 * Rewrite `targetPath` from the session's DB rows. Defaults to the session's
 * canonical file under the projects root — in that case sync info is
 * refreshed so the read-through cache serves the fresh file immediately.
 */
export function exportSessionToFile(
  store: SessionStore,
  sessionId: string,
  targetPath?: string,
): ExportResult | null {
  const row = store.getSession(sessionId)
  if (!row) return null

  const path =
    targetPath ??
    join(getClaudeConfigHomeDir(), 'projects', row.projectDir, `${sessionId}.jsonl`)

  const rows = store.getMessages({ sessionId, limit: Number.MAX_SAFE_INTEGER })
  if (rows.length === 0) return null

  // Meta rows physically precede the boundary — write them first so a large
  // file's byte scan of [0, boundary) recovers them (see module doc).
  const meta = rows.filter(r => r.role === 'meta')
  const main = rows.filter(r => r.role !== 'meta')
  const content = [...meta, ...main].map(r => JSON.stringify(r.data)).join('\n') + '\n'

  mkdirSync(dirname(path), { recursive: true })
  // Atomic-ish replace: tmp file + rename in the same directory.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)

  // Canonical target → refresh sync info (stat after the bytes exist and
  // match them exactly, the same pre-read semantics the sync uses).
  let repairedCanonical = false
  if (targetPath === undefined) {
    const st = statSync(path)
    store.setSyncInfo(sessionId, st.size, Math.trunc(st.mtimeMs), path)
    repairedCanonical = true
  }

  return { sessionId, targetPath: path, entries: rows.length, repairedCanonical }
}

/** Export every session that has rows into its canonical file. */
export function exportAllSessions(store: SessionStore): ExportResult[] {
  const results: ExportResult[] = []
  const metas = store.listSessions({ limit: Number.MAX_SAFE_INTEGER })
  for (const meta of metas) {
    try {
      const result = exportSessionToFile(store, meta.id)
      if (result) results.push(result)
    } catch (err) {
      logForDebugging(`export failed for ${meta.id}: ${String(err)}`)
    }
  }
  return results
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2)
  const store = SessionStore.open()
  try {
    if (args.includes('--all')) {
      const results = exportAllSessions(store)
      console.log(`Exported ${results.length} sessions`)
    } else if (args[0]) {
      const sessionId = args[0]
      const targetIdx = args.indexOf('--output')
      const target = targetIdx !== -1 ? args[targetIdx + 1] : undefined
      const result = exportSessionToFile(store, sessionId, target)
      if (!result) {
        console.error(`Session not found or empty: ${sessionId}`)
        process.exit(1)
      }
      console.log(
        `Exported ${result.sessionId}: ${result.entries} entries → ${result.targetPath}`,
      )
    } else {
      console.log(
        'Usage: bun run src/services/db/exportSession.ts <sessionId> [--output path] | --all',
      )
    }
  } finally {
    store.close()
  }
}
