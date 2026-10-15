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
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { SessionStore } from './SessionStore.js'
import { parseJSONL } from '../../utils/json.js'
import { isTranscriptMessage } from '../../utils/sessionStorage.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Entry } from '../../types/logs.js'

interface MigrationOptions {
  dryRun?: boolean
  projectDir?: string
  verbose?: boolean
  vacuum?: boolean
}

interface MigrationResult {
  total: number
  migrated: number
  skipped: number
  failed: number
  errors: Array<{ session: string; error: string }>
}

async function findSessionFiles(projectDir: string): Promise<string[]> {
  const sessionsDir = join(getClaudeConfigHomeDir(), 'projects', projectDir)
  const files: string[] = []

  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(join(sessionsDir, entry.name))
      } else if (entry.isDirectory()) {
        // Check for session subdirectories (e.g., subagent sessions)
        const subFiles = await findSessionFiles(join(projectDir, entry.name))
        files.push(...subFiles)
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return files
}

async function getProjectDirs(): Promise<string[]> {
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

async function migrateSession(
  store: SessionStore,
  filePath: string,
  projectDir: string,
  options: MigrationOptions,
): Promise<'migrated' | 'skipped' | 'failed'> {
  const sessionId = basename(filePath, '.jsonl')

  try {
    // Check if already in DB
    const existing = store.getSession(sessionId)
    if (existing && existing.messageCount > 0) {
      return 'skipped'
    }

    if (options.dryRun) {
      return 'migrated'
    }

    // Read JSONL file
    const content = await readFile(filePath, 'utf-8')
    const entries = parseJSONL<Entry>(content)

    if (entries.length === 0) {
      return 'skipped'
    }

    // Extract metadata
    const firstTimestamp = (entries[0] as { timestamp?: string }).timestamp
    const createdAt = firstTimestamp ? new Date(firstTimestamp).getTime() : Date.now()
    const now = Date.now()

    let title: string | undefined
    let tag: string | undefined
    let agentName: string | undefined
    let agentColor: string | undefined

    for (const entry of entries) {
      if (entry.type === 'custom-title' && !title) title = (entry as { customTitle?: string }).customTitle
      if (entry.type === 'tag' && !tag) tag = (entry as { tag?: string }).tag
      if (entry.type === 'agent-name' && !agentName) agentName = (entry as { agentName?: string }).agentName
      if (entry.type === 'agent-color' && !agentColor) agentColor = (entry as { agentColor?: string }).agentColor
    }

    // Insert session
    store.createSession({
      id: sessionId,
      projectDir,
      title,
      tag,
      agentName,
      agentColor,
      createdAt,
      updatedAt: now,
    })

    // Insert messages
    const transcriptEntries = entries.filter(e => isTranscriptMessage(e) || e.type === 'summary')
    store.appendMessages(sessionId, transcriptEntries)

    if (options.verbose) {
      logForDebugging(`  Migrated ${sessionId}: ${transcriptEntries.length} entries`)
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

  const store = SessionStore.open()

  try {
    const projectDirs = options.projectDir
      ? [options.projectDir]
      : await getProjectDirs()

    logForDebugging(`Found ${projectDirs.length} project directories`)

    for (const dir of projectDirs) {
      const files = await findSessionFiles(dir)
      logForDebugging(`Project ${dir}: ${files.length} session files`)

      for (const file of files) {
        result.total++
        const sessionId = basename(file, '.jsonl')

        const status = await migrateSession(store, file, dir, options)
        if (status === 'migrated') result.migrated++
        else if (status === 'skipped') result.skipped++
        else {
          result.failed++
          result.errors.push({ session: sessionId, error: 'Migration failed' })
        }
      }
    }

    if (options.vacuum && !options.dryRun) {
      logForDebugging('Vacuuming database...')
      store.vacuum()
    }
  } finally {
    store.close()
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
