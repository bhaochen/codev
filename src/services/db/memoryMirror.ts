/**
 * Memory file mirror — SQLite backup for auto-memory.
 *
 * Auto-memory is pure filesystem: the agent writes MEMORY.md / topic files /
 * daily logs straight into `<configHome>/projects/<project>/memory/` through
 * the standard Write/Edit tools (with a permission carve-out), so — unlike
 * transcripts, which all funnel through sessionStorage seams — there is no
 * single choke point where rows could be written first.
 *
 * The mirror therefore runs in the OPPOSITE direction from the transcript
 * shadow: files stay the live truth while they exist, and a best-effort sync
 * copies them INTO SQLite (rows are the backup). Three operations:
 *
 *   - `persistMemoryFile` — the DB-primary write seam: the file tools call it
 *     right after every successful Write/Edit to a memory path, BEFORE the
 *     tool returns, so agent-written memory is durable in SQLite immediately
 *     (a wiped projects tree can never lose tool-written memory). Bash writes
 *     bypass this seam and are covered by the syncs below.
 *   - `syncMemoryDirFromDisk` — full pass: walk the dir, replace the scope's
 *     rows atomically. Reconciles Bash-written/deleted files. Triggered when
 *     codev knows memory changed: extractMemories completion, autoDream
 *     consolidation, and the process-exit hook.
 *   - `restoreMemoryDirIfMissing` — rows → disk: when the harness touches a
 *     memory dir whose MEMORY.md is gone (user wiped the projects data, new
 *     machine, disk loss), rebuild every row's file. Called from the memory
 *     read path (ensureMemoryDirExists, scanMemoryFiles).
 *
 * Asymmetry is deliberate: a WHOLE missing directory is treated as data loss
 * and restored; a missing individual file while MEMORY.md survives is treated
 * as an intentional deletion (the agent prunes memories by rm) and is only
 * propagated to the rows by the next sync — never resurrected.
 *
 * All db-layer imports are dynamic (same cycle rationale as shadowWriter.ts:
 * memdir.ts reaches this module from the read path while the db layer
 * imports session-storage utilities). The one exception is the exit hook,
 * which uses require() — it runs once at process exit where cycles cannot
 * re-enter.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import type { SessionStore } from './SessionStore.js'

/** Skip dotfiles (.consolidate-lock, .DS_Store, …) and anything huge. */
const MAX_MEMORY_FILE_BYTES = 5 * 1024 * 1024

/** Memory dirs this process has seen (for the exit-sync hook). */
const seenDirs = new Set<string>()

// ─────────────────────────────────────────────────────────────────────────────
// Scope derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable scope key for a memory dir. The default layout
 * `<configHome>/projects/<project>/memory/` maps to `<project>` — the same
 * key space as `sessions.project_dir`, so a wiped-and-restored projects tree
 * keeps matching. Overrides (env var / settings autoMemoryDirectory) fall
 * back to the absolute path so they still get a stable key.
 */
export function memoryScopeForDir(memDir: string): string {
  const projectsRoot = join(getClaudeConfigHomeDir(), 'projects') + sep
  const normalized = memDir.replace(/[\\/]+$/, '')
  if (normalized.startsWith(projectsRoot)) {
    const rel = normalized.slice(projectsRoot.length)
    // Default layout: <project>/memory (team lives at <project>/memory/team).
    // Strip the memory subtree so all of a project's memory dirs share one
    // scope — the same key space as sessions.project_dir.
    return rel.replace(/[/\\]memory(?:[/\\].*)?$/, '') || rel
  }
  return normalized
}

// ─────────────────────────────────────────────────────────────────────────────
// Disk walk
// ─────────────────────────────────────────────────────────────────────────────

function walkMemoryFiles(
  memDir: string,
): Array<{ relPath: string; content: string }> {
  const files: Array<{ relPath: string; content: string }> = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        if (statSync(full).size > MAX_MEMORY_FILE_BYTES) continue
        files.push({
          relPath: relative(memDir, full).split(sep).join('/'),
          content: readFileSync(full, 'utf8'),
        })
      } catch {
        // Unreadable file — skip, the next sync retries.
      }
    }
  }
  walk(memDir)
  return files
}

// ─────────────────────────────────────────────────────────────────────────────
// Store resolution (dynamic import — cycle rationale in the module doc)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveStore(): Promise<SessionStore | null> {
  try {
    const { resolveShadowStore } = await import('./shadowWriter.js')
    return await resolveShadowStore()
  } catch (err) {
    logForDebugging(`memoryMirror: store unavailable: ${String(err)}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync (disk → rows)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DB-primary durability for a single agent write (the file tools call this
 * right after a successful write to a memory path, BEFORE the tool returns):
 * upsert the row so the write is durable in SQLite immediately. Siblings are
 * untouched. Never throws — a failed upsert just leaves the row to the next
 * sync. Returns true when the row was written.
 */
export async function persistMemoryFile(
  absPath: string,
  content: string,
): Promise<boolean> {
  try {
    const store = await resolveStore()
    if (!store) return false
    const memDir = memoryDirForFile(absPath)
    if (!memDir) return false
    store.upsertMemoryFile(
      memoryScopeForDir(memDir),
      relative(memDir, absPath).split(sep).join('/'),
      content,
    )
    seenDirs.add(memDir)
    ensureExitHook()
    return true
  } catch (err) {
    logForDebugging(`memoryMirror: persist failed for ${absPath}: ${String(err)}`)
    return false
  }
}

/**
 * Row deletion for an agent delete at a known path (kept for symmetry; the
 * file tools have no delete — agent rm runs through Bash and is reconciled
 * by the next full sync instead).
 */
export async function forgetMemoryFile(absPath: string): Promise<boolean> {
  try {
    const store = await resolveStore()
    if (!store) return false
    const memDir = memoryDirForFile(absPath)
    if (!memDir) return false
    store.deleteMemoryFile(
      memoryScopeForDir(memDir),
      relative(memDir, absPath).split(sep).join('/'),
    )
    return true
  } catch (err) {
    logForDebugging(`memoryMirror: forget failed for ${absPath}: ${String(err)}`)
    return false
  }
}

/**
 * The memory dir a file belongs to (only paths that ARE inside a memory dir).
 * Returns undefined for everything else, so callers can gate cheaply.
 */
export function memoryDirForFile(absPath: string): string | undefined {
  try {
    // Dynamic import: paths.ts pulls settings/config (heavy, config-guarded).
    const { getAutoMemPath, isAutoMemPath } =
      require('../../memdir/paths.js') as typeof import('../../memdir/paths.js')
    if (!isAutoMemPath(absPath)) return undefined
    return getAutoMemPath()
  } catch {
    return undefined
  }
}

/**
 * Mirror every file under `memDir` into the store (full replace per scope).
 * Returns the number of files mirrored, or null when the store/dir is
 * unavailable. Never throws — the mirror must not break its callers.
 */
export async function syncMemoryDirFromDisk(
  memDir: string,
): Promise<number | null> {
  try {
    if (!existsSync(memDir)) return null
    const store = await resolveStore()
    if (!store) return null
    const files = walkMemoryFiles(memDir)
    store.replaceMemoryFiles(memoryScopeForDir(memDir), files)
    seenDirs.add(memDir)
    ensureExitHook()
    return files.length
  } catch (err) {
    logForDebugging(`memoryMirror: sync failed for ${memDir}: ${String(err)}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore (rows → disk)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Restore the memory directory from rows when its entrypoint (MEMORY.md) is
 * missing. Individual missing files are NOT restored while MEMORY.md exists —
 * see the module doc for the deletion asymmetry. Returns true when bytes were
 * written. Never throws.
 */
export async function restoreMemoryDirIfMissing(
  memDir: string,
): Promise<boolean> {
  try {
    const entrypoint = join(memDir, 'MEMORY.md')
    if (existsSync(entrypoint)) return false
    const store = await resolveStore()
    if (!store) return false
    const rows = store.getMemoryFiles(memoryScopeForDir(memDir))
    if (rows.length === 0) return false
    mkdirSync(memDir, { recursive: true, mode: 0o700 })
    let restored = 0
    for (const row of rows) {
      // POSIX separators from the mirror; join re-platforms them.
      const target = join(memDir, ...row.relPath.split('/'))
      if (existsSync(target)) continue
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(target, row.content, { mode: 0o600 })
      restored++
    }
    if (restored > 0) {
      logForDebugging(
        `memoryMirror: restored ${restored}/${rows.length} files for ${memDir}`,
      )
    }
    return restored > 0
  } catch (err) {
    logForDebugging(
      `memoryMirror: restore failed for ${memDir}: ${String(err)}`,
    )
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit hook — files are the live truth, so the exit sync closes the crash
// window for writes that happened after the last explicit sync trigger.
// ─────────────────────────────────────────────────────────────────────────────

let exitHookInstalled = false
function ensureExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    let store: SessionStore | null = null
    try {
      const { resolveShadowStoreSync } =
        require('./shadowWriter.js') as typeof import('./shadowWriter.js')
      store = resolveShadowStoreSync()
    } catch {
      return
    }
    if (!store) return
    for (const dir of seenDirs) {
      try {
        if (!existsSync(dir)) continue
        store.replaceMemoryFiles(memoryScopeForDir(dir), walkMemoryFiles(dir))
      } catch {
        // Never let the mirror affect process exit.
      }
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — backfill / manual sync / restore / inspect
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable custom-rules/no-sync-fs -- CLI entry, not a hot path */
if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'help'
  void (async () => {
    if (command === 'sync-all') {
      // Backfill: every projects/*/memory dir on disk.
      const projectsRoot = join(getClaudeConfigHomeDir(), 'projects')
      let dirs = 0
      try {
        for (const project of readdirSync(projectsRoot, {
          withFileTypes: true,
        })) {
          if (!project.isDirectory()) continue
          const memDir = join(projectsRoot, project.name, 'memory')
          if (!existsSync(memDir)) continue
          const n = await syncMemoryDirFromDisk(memDir)
          if (n !== null) {
            dirs++
            console.log(`synced ${memDir}: ${n} files`)
          }
        }
      } catch {
        // No projects tree yet.
      }
      console.log(`done — ${dirs} memory dir(s) mirrored`)
    } else if (command === 'sync' || command === 'restore') {
      const { getAutoMemPath } = await import('../../memdir/paths.js')
      const dir = args[1] ?? getAutoMemPath()
      if (command === 'sync') {
        const n = await syncMemoryDirFromDisk(dir)
        console.log(n === null ? `sync failed for ${dir}` : `synced ${n} files`)
      } else {
        const ok = await restoreMemoryDirIfMissing(dir)
        console.log(ok ? `restored ${dir}` : `nothing to restore for ${dir}`)
      }
    } else if (command === 'list') {
      const store = await resolveStore()
      for (const scope of store?.listMemoryScopes() ?? []) {
        console.log(`${scope}: ${store!.getMemoryFiles(scope).length} files`)
      }
    } else {
      console.log(
        'Usage: bun run src/services/db/memoryMirror.ts sync-all | sync [dir] | restore [dir] | list',
      )
    }
  })()
}
/* eslint-enable custom-rules/no-sync-fs */

/** Test hook — clears the seen-dir set and exit-hook flag. */
export function __resetMemoryMirrorForTests(): void {
  seenDirs.clear()
  exitHookInstalled = false
}
