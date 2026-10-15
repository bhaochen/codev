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
 */
import { readdir, readFile, stat, realpath } from 'node:fs/promises'
import { join, basename, relative } from 'node:path'
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
  onProgress?: (status: 'migrated' | 'skipped' | 'failed', sessionId: string) => void
  // Internal: single shared store for bulk migration
  _store?: SessionStore
}

interface MigrationResult {
  total: number
  migrated: number
  skipped: number
  failed: number
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
): Promise<'migrated' | 'skipped' | 'failed'> {
  const { filePath, sessionId, projectDir, isSubagent } = sessionFile

  try {
    // Check if already in DB
    const existing = store.getSession(sessionId)
    if (existing && existing.messageCount > 0) {
      return 'skipped'
    }

    if (options.dryRun) {
      return 'migrated'
    }

    // Get file stat for sync info
    const fileStat = await stat(filePath)
    const resolvedPath = await realpath(filePath)

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
      store.setSyncInfo(sessionId, fileStat.size, Math.trunc(fileStat.mtimeMs), resolvedPath)
    })

    if (options.verbose) {
      logForDebugging(`  Migrated ${sessionId}: ${mainEntries.length + metadataEntries.length} entries`)
    }

    return 'migrated'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`  Failed ${sessionId}: ${message}`)
    return 'failed'
  }
}

export async function migrateAllSessions(options: MigrationOptions = {}): Promise<MigrationResult> {
  const result: MigrationResult = {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }

  // Reuse existing store if provided (for background migration), else create new
  const store = options._store ?? SessionStore.open()
  const shouldCloseStore = !options._store

  try {
    const projectDirs = options.projectDir
      ? [options.projectDir]
      : await getProjectDirs()

    logForDebugging(`Found ${projectDirs.length} project directories`)

    for (const dir of projectDirs) {
      const sessionFiles = await findSessionFiles(dir)
      logForDebugging(`Project ${dir}: ${sessionFiles.length} session files`)

      for (const sessionFile of sessionFiles) {
        result.total++
        const status = await migrateSession(store, sessionFile, options)
        if (status === 'migrated') result.migrated++
        else if (status === 'skipped') result.skipped++
        else {
          result.failed++
          result.errors.push({ session: sessionFile.sessionId, error: 'Migration failed' })
        }
        // Fire progress callback for live spinner
        options.onProgress?.(status, sessionFile.sessionId)
      }
    }

    if (options.vacuum && !options.dryRun) {
      logForDebugging('Vacuuming database...')
      store.vacuum()
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
  console.log(`  Skipped: ${result.skipped}`)
  console.log(`  Failed: ${result.failed}`)

  if (result.errors.length > 0) {
    console.log('\nErrors:')
    for (const err of result.errors) {
      console.log(`  ${err.session}: ${err.error}`)
    }
  }
}
