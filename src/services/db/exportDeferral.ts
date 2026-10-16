/**
 * D4 — deferred JSONL export.
 *
 * In DB-primary mode the JSONL file stopped being the source of truth (D1/D3):
 * every entry is durable in SQLite first, and the file is an *export*. D4
 * takes the final step — the high-frequency append path no longer touches the
 * file at all. Nothing can be lost: the rows are the record; the file is
 * reconstructed on demand.
 *
 * Who still needs the file, and how they get it:
 *   - Hook scripts / statusline commands receive `transcript_path` (or
 *     `agent_transcript_path`) in their JSON input and read it themselves.
 *     `materializeExportForPath` is called right before such a command runs
 *     (see utils/hooks.ts), so the file exists and is current for them.
 *   - External tools (editors, the `sessions export` CLI) ask for a file
 *     explicitly — the CLI rewrites from rows.
 *   - Anything that watches the file continuously (an IDE extension polling
 *     the path) should run with `CODEV_SESSION_EXPORT=1`, which restores the
 *     eager D3 behavior of writing the export on every append.
 *
 * Cost model: deferral is strictly cheaper than D3 when nobody reads the file
 * (no redundant writes). When something does read it, the append fast path
 * only writes the rows the file is missing; the slow path (first touch in a
 * process, an externally modified file, or pending pre-boundary metadata) does
 * one full rewrite from rows.
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isDbPrimaryMode } from '../../utils/sessionPersistence.js'
import { parseSessionPath, resolveShadowStore } from './shadowWriter.js'

/** Files that received row appends this process and are not on disk yet. */
const dirtyPaths = new Set<string>()

/**
 * Per-session watermark of what we know is in the file: the seq of the last
 * row written to it and the file size right after we wrote it. Absent → the
 * file's state is unknown to this process and must be rewritten from rows.
 */
const watermarks = new Map<string, { seq: number; size: number }>()

/**
 * D4 gate: primary mode with the eager-export escape hatch closed. Set
 * `CODEV_SESSION_EXPORT=1` to restore per-append export writing.
 */
export function isExportDeferred(): boolean {
  return isDbPrimaryMode() && !isEnvTruthy(process.env.CODEV_SESSION_EXPORT)
}

/**
 * Record that `jsonlPath` fell behind its rows (the append seam skipped the
 * file write). Callers pair this with skipping the file write, so the dirty
 * flag exactly mirrors "the file is missing bytes we hold".
 */
export function markExportDirty(jsonlPath: string): void {
  if (!isExportDeferred()) return
  dirtyPaths.add(jsonlPath)
}

/**
 * Ensure the export file at `jsonlPath` exists and contains every row.
 * Returns true when bytes were written. No-op when export is eager, when the
 * path is not a session transcript, or when the file is already current.
 */
export async function materializeExportForPath(
  jsonlPath: string,
): Promise<boolean> {
  if (!isExportDeferred()) return false
  if (!jsonlPath) return false

  const isDirty = dirtyPaths.has(jsonlPath)
  let liveSize: number | null = null
  try {
    liveSize = statSync(jsonlPath).size
  } catch {
    liveSize = null
  }
  // Clean and present → nothing to do (the common hot path for a second hook
  // in the same turn: one stat, no query).
  if (!isDirty && liveSize !== null) return false

  const parsed = parseSessionPath(jsonlPath)
  if (!parsed) return false

  try {
    const { exportSessionToFile } = await import('./exportSession.js')
    const store = await resolveShadowStore()
    if (!store) return false
    const sessionId = parsed.sessionId

    // Fast path: we know exactly what the file has, and it still has it —
    // append only the rows past the watermark. Meta rows cannot be appended
    // (they must physically precede the boundary) → fall through to rewrite.
    const wm = watermarks.get(sessionId)
    if (liveSize !== null && wm && wm.size === liveSize) {
      const pending = store.getMessages({
        sessionId,
        afterSeq: wm.seq,
        limit: Number.MAX_SAFE_INTEGER,
      })
      if (pending.length > 0 && pending.every(r => r.role !== 'meta')) {
        const content =
          pending.map(r => JSON.stringify(r.data)).join('\n') + '\n'
        try {
          appendFileSync(jsonlPath, content, { mode: 0o600 })
        } catch {
          mkdirSync(dirname(jsonlPath), { recursive: true, mode: 0o700 })
          appendFileSync(jsonlPath, content, { mode: 0o600 })
        }
        watermarks.set(sessionId, {
          seq: pending[pending.length - 1]!.seq,
          size: statSync(jsonlPath).size,
        })
        dirtyPaths.delete(jsonlPath)
        return true
      }
    }

    // Slow path: full rewrite from rows (atomic tmp+rename inside
    // exportSessionToFile). Covers the first touch in a process, a file
    // someone else truncated or removed, and pending meta rows.
    const result = exportSessionToFile(store, sessionId, jsonlPath)
    dirtyPaths.delete(jsonlPath)
    if (!result) return false
    const rows = store.getMessages({
      sessionId,
      limit: Number.MAX_SAFE_INTEGER,
    })
    watermarks.set(sessionId, {
      seq: rows.at(-1)?.seq ?? 0,
      size: statSync(jsonlPath).size,
    })
    return true
  } catch {
    // Best-effort: a failed materialization must not break the caller. The
    // path stays dirty so the next attempt retries.
    return false
  }
}

/** Test hook — clears the in-process dirty set and watermarks. */
export function __resetExportDeferralForTests(): void {
  dirtyPaths.clear()
  watermarks.clear()
}
