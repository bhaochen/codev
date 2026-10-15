/**
 * Session Migration Tool — Batch migrate JSONL session files to SQLite.
 *
 * Usage:
 *   bun run src/services/db/migrateSessions.ts [options]
 *
 * Options:
 *   --dry-run       Show what would be migrated without making changes
 *   --project-dir   Only migrate sessions for a specific project directory
 *   --verbose       Show detailed progress
 *   --vacuum        Vacuum database after migration
 *   --no-prune      Keep orphaned DB rows whose source JSONL is gone
 *
 * The migration is also a REPAIR pass: a session is skipped only when its
 * stored rows are the canonical view of the CURRENT file (synced_path matches
 * the live realpath and synced_size/mtime match the live stat). Rows from an
 * older migration that lack sync info, or whose source file changed since the
 * last sync, are re-synced — so "migration complete" means every top-level
 * session in SQLite matches its JSONL source exactly.
 */
import { readdir, stat, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { SessionStore } from './SessionStore.js'
import { parseTranscriptFile } from '../../utils/sessionStorage.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Entry } from '../../types/logs.js'

interface MigrationOptions {
  dryRun?: boolean
  projectDir?: string
  verbose?: boolean
  vacuum?: boolean
  /** Delete DB rows whose top-level source JSONL no longer exists (default true). */
  prune?: boolean
  onProgress?: (
    status: 'migrated' | 'repaired' | 'skipped' | 'failed',
    sessionId: string,
  ) => void
  // Internal: single shared store for bulk migration
  _store?: SessionStore
}

interface MigrationResult {
  total: number
  migrated: number
  /** Rows existed but were stale (missing sync info / file changed) and got re-synced. */
  repaired: number
  skipped: number
  failed: number
  /** Orphaned DB rows deleted (source JSONL gone; wrong-key duplicates). */
  pruned: number
  errors: Array<{ session: string; error: string }>
}

/**
 * Session file info with collision-safe session ID.
 * Session ID is the path relative to the projects directory (e.g., "abc.jsonl" or "sessionId/subagents/agent-xyz.jsonl").
 * This prevents collisions when same-named files exist in different subdirectories.
 */
interface SessionFile {
  filePath: string
  sessionId: string
  projectDir: string
  isSubagent: boolean
}

export async function findSessionFiles(projectDir: string): Promise<SessionFile[]> {
  const sessionsDir = join(getClaudeConfigHomeDir(), 'projects', projectDir)
  const files: SessionFile[] = []

  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(sessionsDir, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Top-level session file: <sessionId>.jsonl
        // Session ID is relative path WITHOUT .jsonl extension for backward compatibility
        const relPath = relative(sessionsDir, fullPath)
        const sessionId = relPath.endsWith('.jsonl') ? relPath.slice(0, -6) : relPath
        files.push({
          filePath: fullPath,
          sessionId,
          projectDir,
          isSubagent: false,
        })
      } else if (entry.isDirectory()) {
        // Skip subagent directories (sessionId/subagents/) - they are not top-level sessions
        if (entry.name === 'subagents') continue
        // Recurse into nested project directories
        const subFiles = await findSessionFiles(join(projectDir, entry.name))
        files.push(...subFiles)
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return files
}

export async function getProjectDirs(): Promise<string[]> {
  const projectsDir = join(getClaudeConfigHomeDir(), 'projects')
  const dirs: string[] = []

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name)
      }
    }
  } catch {
    // No projects directory
  }

  return dirs
}

export async function migrateSession(
  store: SessionStore,
  sessionFile: SessionFile,
  options: MigrationOptions,
): Promise<'migrated' | 'repaired' | 'skipped' | 'failed'> {
  const { filePath, sessionId, projectDir } = sessionFile

  try {
    // Get live file stat up front: both the skip decision and the freshness
    // mark need it, and taking it once keeps them consistent.
    const fileStat = await stat(filePath)
    const resolvedPath = await realpath(filePath)
    const size = fileStat.size
    const mtime = Math.trunc(fileStat.mtimeMs)

    // Skip ONLY when the stored rows are the canonical view of the current
    // file: sync info present, pointing at this exact path, matching this
    // exact stat. Anything else (rows from an older migration without sync
    // info, a file that grew or was compacted) is re-synced below — this is
    // the repair pass that makes "migration complete" mean fully synced.
    const existing = store.getSession(sessionId)
    const existingIsCurrent =
      existing !== null &&
      existing.messageCount > 0 &&
      existing.syncedPath === resolvedPath &&
      existing.syncedSize === size &&
      existing.syncedMtime === mtime
    if (existingIsCurrent) {
      return 'skipped'
    }

    const hadRows = existing !== null && existing.messageCount > 0

    if (options.dryRun) {
      return hadRows ? 'repaired' : 'migrated'
    }

    // Parse using the canonical streaming pipeline (handles large files efficiently)
    const { mainEntries, metadataEntries } = await parseTranscriptFile(filePath)

    if (mainEntries.length === 0 && metadataEntries.length === 0) {
      return 'skipped'
    }

    // Atomic migration: wrap in transaction so crash = rollback (JSONL preserved)
    store.transaction(() => {
      // Full-fidelity mirror: syncSession stores EVERY entry with role separation
      store.syncSession(sessionId, projectDir, mainEntries, metadataEntries)
      // Record sync info so read-through cache treats this as fresh
      store.setSyncInfo(sessionId, size, mtime, resolvedPath)
    })

    if (options.verbose) {
      logForDebugging(
        `  ${hadRows ? 'Repaired' : 'Migrated'} ${sessionId}: ${mainEntries.length + metadataEntries.length} entries`,
      )
    }

    return hadRows ? 'repaired' : 'migrated'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`  Failed ${sessionId}: ${message}`)
    return 'failed'
  }
}

/**
 * Delete DB rows for sessions in `projectDir` whose top-level source JSONL no
 * longer exists. This cleans up two classes of orphan created by earlier
 * migration versions:
 *   - rows keyed by a filename WITH the .jsonl extension (old sessionId bug),
 *   - subagent transcripts (sessionId/subagents/agent-*.jsonl) that were
 *     wrongly migrated as top-level sessions.
 *
 * Safe by construction: JSONL is the source of truth, SQLite is a rebuildable
 * cache, and a row whose source is gone can never be re-read correctly anyway
 * (an existing file is never touched — that row is left for the repair pass).
 */
async function pruneOrphans(
  store: SessionStore,
  projectDir: string,
): Promise<{ pruned: number; errors: Array<{ session: string; error: string }> }> {
  const errors: Array<{ session: string; error: string }> = []
  const projectsRoot = join(getClaudeConfigHomeDir(), 'projects')
  let pruned = 0

  let metas
  try {
    metas = store.listSessions({ projectDir, limit: Number.MAX_SAFE_INTEGER })
  } catch (error) {
    return { pruned: 0, errors: [{ session: projectDir, error: `listSessions: ${String(error)}` }] }
  }

  for (const meta of metas) {
    try {
      // A DB key of "x.jsonl" produced by the old bug maps to
      // projects/<dir>/x.jsonl.jsonl (missing → pruned); any key whose real
      // source file exists is kept.
      const sourcePath = join(projectsRoot, projectDir, `${meta.id}.jsonl`)
      if (existsSync(sourcePath)) continue
      store.deleteSession(meta.id)
      pruned++
      logForDebugging(`  Pruned orphan ${meta.id} (no source at ${sourcePath})`)
    } catch (error) {
      errors.push({ session: meta.id, error: String(error) })
    }
  }

  return { pruned, errors }
}

export async function migrateAllSessions(options: MigrationOptions = {}): Promise<MigrationResult> {
  const result: MigrationResult = {
    total: 0,
    migrated: 0,
    repaired: 0,
    skipped: 0,
    failed: 0,
    pruned: 0,
    errors: [],
  }

  // Reuse existing store if provided (for background migration), else create new
  const store = options._store ?? SessionStore.open()
  const shouldCloseStore = !options._store
  const shouldPrune = options.prune !== false && !options.dryRun

  try {
    const projectDirs = options.projectDir
      ? [options.projectDir]
      : await getProjectDirs()

    logForDebugging(`Found ${projectDirs.length} project directories`)

    for (const dir of projectDirs) {
      const sessionFiles = await findSessionFiles(dir)
      logForDebugging(`Project ${dir}: ${sessionFiles.length} session files`)

      // Prune orphaned rows first (wrong-key duplicates from old migration
      // versions, subagent transcripts, deleted sessions) so the repair pass
      // reports against a clean table.
      if (shouldPrune) {
        const pruneResult = await pruneOrphans(store, dir)
        result.pruned += pruneResult.pruned
        result.errors.push(...pruneResult.errors)
      }

      for (const sessionFile of sessionFiles) {
        result.total++
        const status = await migrateSession(store, sessionFile, options)
        if (status === 'migrated') result.migrated++
        else if (status === 'repaired') result.repaired++
        else if (status === 'skipped') result.skipped++
        else {
          result.failed++
          result.errors.push({ session: sessionFile.sessionId, error: 'Migration failed' })
        }
        // Fire progress callback for live spinner
        options.onProgress?.(status, sessionFile.sessionId)
      }
    }

    // Vacuum when this run changed data (migrated/repaired/pruned) OR when a
    // large freelist has accumulated (e.g. left behind by an earlier prune) —
    // a steady-state verification pass on a tidy file must not rewrite the
    // whole (multi-GB) database. Failures are non-fatal: the data is already
    // committed; vacuum only reclaims space.
    const FREELIST_VACUUM_THRESHOLD = 0.2
    if (options.vacuum && !options.dryRun) {
      const changed = result.migrated > 0 || result.repaired > 0 || result.pruned > 0
      const bloated = store.freelistRatio() > FREELIST_VACUUM_THRESHOLD
      if (changed || bloated) {
        try {
          logForDebugging(
            `Vacuuming database... (changed=${changed} freelist=${(store.freelistRatio() * 100).toFixed(1)}%)`,
          )
          store.vacuum()
        } catch (error) {
          logForDebugging(`Vacuum failed (non-fatal): ${String(error)}`)
        }
      }
    }
  } finally {
    if (shouldCloseStore) {
      store.close()
    }
  }

  return result
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2)
  const options: MigrationOptions = {
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    vacuum: args.includes('--vacuum'),
    prune: !args.includes('--no-prune'),
  }

  const projectDirIdx = args.indexOf('--project-dir')
  if (projectDirIdx !== -1 && args[projectDirIdx + 1]) {
    options.projectDir = args[projectDirIdx + 1]
  }

  logForDebugging('Starting session migration...')
  logForDebugging(`Options: ${JSON.stringify(options)}`)

  const result = await migrateAllSessions(options)

  console.log('\nMigration complete:')
  console.log(`  Total sessions: ${result.total}`)
  console.log(`  Migrated: ${result.migrated}`)
  console.log(`  Repaired (re-synced stale rows): ${result.repaired}`)
  console.log(`  Skipped (already fresh): ${result.skipped}`)
  console.log(`  Pruned orphans: ${result.pruned}`)
  console.log(`  Failed: ${result.failed}`)

  if (result.errors.length > 0) {
    console.log('\nErrors:')
    for (const err of result.errors) {
      console.log(`  ${err.session}: ${err.error}`)
    }
  }
}
