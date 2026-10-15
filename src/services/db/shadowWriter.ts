/**
 * Phase A shadow writer — mirrors JSONL transcript appends into SQLite.
 *
 * The JSONL file remains the source of truth; every append that lands in a
 * session file ALSO lands in the SQLite mirror, so the DB is current the
 * moment a write happens (instead of being caught up lazily at read time).
 * This is the write-side seam that a later phase (DB-primary) will flip:
 * writes will go DB-first with JSONL as an export, without touching every
 * producer.
 *
 * Design:
 *   - Callers hand over (path, entries, bytesWritten) AFTER the file write
 *     succeeded. Nothing here can fail the JSONL path: every error is logged
 *     and swallowed — the read-through cache + repair migration self-heal.
 *   - Entries buffer per session and flush on a debounce (or when the buffer
 *     grows), as ONE transaction with prepared statements.
 *   - The fast path appends incrementally, guarded so it can never diverge
 *     from what parseTranscriptFile would produce:
 *       · rows must be exactly the rows this writer last left (last-row uuid),
 *       · the live file size must equal expectedSize + buffered bytes,
 *       · stored sync info must match the writer's expectedSize,
 *       · a compact boundary, a path change, or a store full of unknown rows
 *         forces a full re-parse+sync instead (boundary semantics — truncation
 *         and metadata re-classification — cannot be derived incrementally).
 *     Any failed guard falls back to full resync; a fully-skipped flush leaves
 *     sync info stale so the next read repairs from the file.
 *   - Subagent transcripts (<session>/subagents/*.jsonl) are deliberately NOT
 *     mirrored (same policy as the bulk migration; agent transcripts are read
 *     from their files directly).
 *
 * All db-layer imports are DYNAMIC: sessionStorage statically imports this
 * module (to hook the write paths), so a static import back would create a
 * module cycle.
 */
import { statSync, realpathSync } from 'node:fs'
import { basename, dirname, relative } from 'node:path'
import { getProjectsDir, SKIP_PRECOMPACT_THRESHOLD } from '../../utils/sessionStoragePortable.js'
import { isDbPrimaryMode, shouldSkipSessionPersistence } from '../../utils/sessionPersistence.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Entry } from '../../types/logs.js'
import type { SessionStore } from './SessionStore.js'

const FLUSH_DEBOUNCE_MS = 200
const MAX_BUFFERED_ENTRIES = 500

type PendingBatch = { entries: Entry[]; bytes: number }

type ShadowState = {
  path: string
  projectDir: string
  batches: PendingBatch[]
  bufferedBytes: number
  bufferedCount: number
  /**
   * File size when the DB rows were last known to be the canonical view of
   * the file. null = unknown (first flush in this process, or a failed
   * resync) → the next flush does a full re-parse.
   */
  expectedSize: number | null
  /** uuid of the last DB row when rows were known-canonical. */
  lastRowUuid: string | null
  /** A compact boundary (or path change) was seen → full resync required. */
  forceResync: boolean
}

const states = new Map<string, ShadowState>()

// ─────────────────────────────────────────────────────────────────────────────
// Store resolution (dynamic import — see module doc for the cycle rationale)
// ─────────────────────────────────────────────────────────────────────────────

let injectedStore: SessionStore | null = null
let defaultStore: SessionStore | null = null
let storeResolveFailed = false

async function resolveStore(): Promise<SessionStore | null> {
  if (injectedStore) return injectedStore
  if (defaultStore) return defaultStore
  if (storeResolveFailed) return null
  try {
    const { getSessionStore } = await import('./SessionStore.js')
    defaultStore = getSessionStore()
    return defaultStore
  } catch (err) {
    // Permanent for this process: shadow writes are best-effort; the JSONL
    // path and the read-time sync are unaffected.
    storeResolveFailed = true
    logForDebugging(`shadowWriter: session store unavailable: ${String(err)}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gates
// ─────────────────────────────────────────────────────────────────────────────

function nodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

function shadowAllowed(jsonlPath: string): boolean {
  if (!jsonlPath.endsWith('.jsonl')) return false
  // Subagent transcripts are not mirrored (see module doc).
  if (jsonlPath.includes('/subagents/')) return false
  if (nodeEnv() === 'test') {
    return isEnvTruthy(process.env.TEST_ENABLE_SHADOW_WRITER)
  }
  return !shouldSkipSessionPersistence()
}

function sessionIdForPath(jsonlPath: string): string | null {
  const name = basename(jsonlPath, '.jsonl')
  return name.length > 0 ? name : null
}

/** Boundary semantics (truncation + metadata re-classification) cannot be
 *  applied incrementally — any compact boundary in a batch forces a re-parse. */
function isCompactBoundaryLike(entry: Entry): boolean {
  return (
    entry.type === 'system' &&
    (entry as { subtype?: string }).subtype === 'compact_boundary'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling
// ─────────────────────────────────────────────────────────────────────────────

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushChain: Promise<void> = Promise.resolve()

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushShadowWrites()
  }, FLUSH_DEBOUNCE_MS)
  // Never keep the process alive just to flush the shadow mirror.
  ;(flushTimer as unknown as { unref?: () => void }).unref?.()
}

/**
 * Flush all buffered shadow writes now (debounce timer cancelled first).
 * Resolves when every session buffer has been processed. Errors are logged,
 * never thrown.
 */
export async function flushShadowWrites(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const run = async (): Promise<void> => {
    for (const [sessionId, st] of states) {
      if (st.bufferedCount > 0 || st.forceResync) {
        await processState(sessionId, st)
      }
    }
  }
  // Never reject: the JSONL path and its callers must not observe shadow
  // failures. processState already swallows per-session errors.
  flushChain = flushChain.then(run, run).catch(err => {
    logForDebugging(`shadowWriter: flush failed: ${String(err)}`)
  })
  return flushChain
}

/**
 * Best-effort SYNCHRONOUS flush for process exit: incremental appends only
 * (full resyncs need async IO and are skipped — a skipped flush just leaves
 * sync info stale, and the next read repairs from the file).
 */
export function flushShadowWritesSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const store = injectedStore ?? defaultStore
  if (!store) return
  const primary = isDbPrimaryMode()
  for (const [sessionId, st] of states) {
    if (primary) {
      // D1: direct row append (sync) — the exit-path contract.
      if (st.bufferedCount === 0) continue
      const entries = st.batches.flatMap(b => b.entries)
      try {
        store.transaction(() => {
          store.ensureSession(sessionId, st.projectDir)
          store.appendMessages(sessionId, entries, 'main')
          store.mergeSessionListingMeta(sessionId, entries)
        })
        clearBuffer(st)
      } catch {
        // Process is exiting — nothing more we can do; the export file (if
        // any) still holds the entries for a future repair.
      }
      continue
    }
    if (st.forceResync || st.bufferedCount === 0) continue
    const entries = st.batches.flatMap(b => b.entries)
    const bytes = st.bufferedBytes
    if (tryIncremental(store, sessionId, st, entries, bytes)) {
      clearBuffer(st)
    }
  }
}

let exitHookInstalled = false
function ensureExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    try {
      flushShadowWritesSync()
    } catch {
      // Never let the shadow writer affect process exit.
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point (called by every JSONL write seam)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror a successful JSONL append into SQLite. `bytesWritten` must be the
 * EXACT byte length of what was appended to the file (Buffer.byteLength of
 * the written string) — it is the writer's only way to prove, at flush time,
 * that the file contains precisely expectedSize + buffered bytes.
 */
export function shadowAppendBatch(
  jsonlPath: string,
  entries: readonly Entry[],
  bytesWritten: number,
): void {
  try {
    if (entries.length === 0) return
    if (!shadowAllowed(jsonlPath)) return
    const sessionId = sessionIdForPath(jsonlPath)
    if (!sessionId) return

    ensureExitHook()

    let st = states.get(sessionId)
    if (!st) {
      st = {
        path: jsonlPath,
        projectDir: relative(getProjectsDir(), dirname(jsonlPath)),
        batches: [],
        bufferedBytes: 0,
        bufferedCount: 0,
        expectedSize: null,
        lastRowUuid: null,
        forceResync: false,
      }
      states.set(sessionId, st)
    } else if (st.path !== jsonlPath) {
      // Same sessionId addressed by a second path in this process (worktree
      // aliasing). Mixing incremental state across files is unsafe.
      st.path = jsonlPath
      st.projectDir = relative(getProjectsDir(), dirname(jsonlPath))
      st.forceResync = true
    }

    st.batches.push({ entries: [...entries], bytes: bytesWritten })
    st.bufferedBytes += bytesWritten
    st.bufferedCount += entries.length
    if (entries.some(isCompactBoundaryLike)) {
      st.forceResync = true
    }

    if (st.bufferedCount >= MAX_BUFFERED_ENTRIES) {
      void flushShadowWrites()
    } else {
      scheduleFlush()
    }
  } catch (err) {
    // The JSONL path must never observe shadow-writer failures.
    logForDebugging(`shadowWriter: append failed: ${String(err)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Flush internals
// ─────────────────────────────────────────────────────────────────────────────

function clearBuffer(st: ShadowState): void {
  st.batches = []
  st.bufferedBytes = 0
  st.bufferedCount = 0
}

async function processState(sessionId: string, st: ShadowState): Promise<void> {
  const store = await resolveStore()
  if (!store) {
    // D1: in primary mode the DB is the only authoritative sink — KEEP the
    // buffer so the next flush retries (the sync seam's file copy is a
    // best-effort export and may be all that exists for the moment).
    if (isDbPrimaryMode()) return
    // Shadow mode: rows stay stale → read repairs from the file.
    clearBuffer(st)
    st.forceResync = false
    return
  }

  // D1 (DB-primary): direct row append — no file-anchored guards, no sync
  // info, no resync-from-file. The file is an export handled by the write
  // seams themselves.
  if (isDbPrimaryMode()) {
    const entries = st.batches.flatMap(b => b.entries)
    if (entries.length > 0) {
      store.transaction(() => {
        store.ensureSession(sessionId, st.projectDir)
        store.appendMessages(sessionId, entries, 'main')
        store.mergeSessionListingMeta(sessionId, entries)
      })
    }
    clearBuffer(st)
    st.forceResync = false
    return
  }

  const entries = st.batches.flatMap(b => b.entries)
  const bytes = st.bufferedBytes
  const mustResync = st.forceResync
  clearBuffer(st)

  if (mustResync) {
    await fullResync(store, sessionId, st)
    return
  }
  if (tryIncremental(store, sessionId, st, entries, bytes)) return
  await fullResync(store, sessionId, st)
}

/**
 * Incremental append — only when provably safe. Returns false (caller then
 * does a full resync) on ANY mismatch.
 */
function tryIncremental(
  store: SessionStore,
  sessionId: string,
  st: ShadowState,
  entries: Entry[],
  bytes: number,
): boolean {
  try {
    if (entries.length === 0) return true // nothing to do
    const stat = statSync(st.path)
    const resolved = realpathSync(st.path)

    // The rows must be exactly what this writer last left.
    if (st.expectedSize === null || st.lastRowUuid === null) return false
    const sync = store.getSyncInfo(sessionId)
    if (!sync || sync.path !== resolved || sync.size !== st.expectedSize) {
      return false
    }
    if (store.getLastMessageUuid(sessionId) !== st.lastRowUuid) return false
    if (!store.getSession(sessionId)) return false

    // Crossing the precompact threshold flips the reader's pruning gates —
    // a full re-parse is required to match what loadTranscriptFile will do.
    if (
      st.expectedSize <= SKIP_PRECOMPACT_THRESHOLD &&
      st.expectedSize + bytes > SKIP_PRECOMPACT_THRESHOLD
    ) {
      return false
    }

    // The live file must be exactly {canonical prefix} + {buffered bytes}:
    // any foreign append (other process) or rewrite fails this.
    if (stat.size !== st.expectedSize + bytes) return false

    store.transaction(() => {
      store.appendMessages(sessionId, entries, 'main')
      // Keep the picker's listing metadata current in the same transaction
      // (lastPrompt/title/tag/gitBranch/... — what readLiteMetadata would
      // scrape from the file tail).
      store.mergeSessionListingMeta(sessionId, entries)
    })
    store.setSyncInfo(sessionId, stat.size, Math.trunc(stat.mtimeMs), resolved)
    st.expectedSize = stat.size
    st.lastRowUuid = store.getLastMessageUuid(sessionId)
    return true
  } catch (err) {
    logForDebugging(`shadowWriter: incremental failed for ${sessionId}: ${String(err)}`)
    return false
  }
}

/**
 * Canonical resync: parse the file with the SAME pipeline the reader uses and
 * replace the rows. Also the adoption point — expectedSize/lastRowUuid are
 * taken from what the resync stored, so subsequent flushes may go incremental.
 */
async function fullResync(
  store: SessionStore,
  sessionId: string,
  st: ShadowState,
): Promise<void> {
  try {
    const { loadTranscriptCached } = await import('./transcriptCache.js')
    await loadTranscriptCached(store, sessionId, st.path, st.projectDir)
    const sync = store.getSyncInfo(sessionId)
    st.expectedSize = sync?.size ?? null
    st.lastRowUuid = store.getLastMessageUuid(sessionId)
    st.forceResync = false
  } catch (err) {
    logForDebugging(`shadowWriter: full resync failed for ${sessionId}: ${String(err)}`)
    st.expectedSize = null
    st.lastRowUuid = null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation (对账) — compare the DB mirror against the JSONL source
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic signature of a transcript shape for equality comparison. */
function shapeSignature(shape: {
  messages: Map<string, unknown>
  summaries: Map<string, unknown>
  customTitles: Map<string, unknown>
  tags: Map<string, unknown>
  agentNames: Map<string, unknown>
  agentColors: Map<string, unknown>
  agentSettings: Map<string, unknown>
  prNumbers: Map<string, unknown>
  prUrls: Map<string, unknown>
  prRepositories: Map<string, unknown>
  modes: Map<string, unknown>
  worktreeStates: Map<string, unknown>
  fileHistorySnapshots: Map<string, unknown>
  attributionSnapshots: Map<string, unknown>
  contentReplacements: Map<string, unknown>
  agentContentReplacements: Map<string, unknown>
  contextCollapseCommits: unknown
  contextCollapseSnapshot: unknown
  leafUuids: Set<string>
  goalStore?: unknown
}): string {
  const m = (map: Map<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(map)
  return JSON.stringify({
    messages: m(shape.messages),
    summaries: m(shape.summaries),
    customTitles: m(shape.customTitles),
    tags: m(shape.tags),
    agentNames: m(shape.agentNames),
    agentColors: m(shape.agentColors),
    agentSettings: m(shape.agentSettings),
    prNumbers: m(shape.prNumbers),
    prUrls: m(shape.prUrls),
    prRepositories: m(shape.prRepositories),
    modes: m(shape.modes),
    worktreeStates: m(shape.worktreeStates),
    fileHistorySnapshots: m(shape.fileHistorySnapshots),
    attributionSnapshots: m(shape.attributionSnapshots),
    contentReplacements: m(shape.contentReplacements),
    agentContentReplacements: m(shape.agentContentReplacements),
    contextCollapseCommits: shape.contextCollapseCommits,
    contextCollapseSnapshot: shape.contextCollapseSnapshot,
    leafUuids: [...shape.leafUuids].sort(),
    goalStore: shape.goalStore,
  })
}

/**
 * Reconciliation helper: flush pending shadow writes, then verify that
 * loadTranscript(DB) ≡ loadTranscriptFile(JSONL) for a session. Returns
 * `{ ok: true }` or `{ ok: false, detail }` describing the divergence.
 * Used by tests and (later) by `codev doctor`.
 */
export async function shadowReconcileSession(
  store: SessionStore,
  jsonlPath: string,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    await flushShadowWrites()
    const sessionId = sessionIdForPath(jsonlPath)
    if (!sessionId) return { ok: false, detail: `not a session path: ${jsonlPath}` }
    const { loadTranscriptFile } = await import('../../utils/sessionStorage.js')
    const fromDb = store.loadTranscript(sessionId)
    const fromFile = await loadTranscriptFile(jsonlPath)
    const sigDb = shapeSignature(fromDb)
    const sigFile = shapeSignature(fromFile)
    if (sigDb === sigFile) return { ok: true }
    return {
      ok: false,
      detail: `shapes differ (db ${sigDb.length} chars vs file ${sigFile.length} chars) for ${sessionId}`,
    }
  } catch (err) {
    return { ok: false, detail: String(err) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test hooks
// ─────────────────────────────────────────────────────────────────────────────

/** Test-only: inject the store used for shadow writes. */
export function __setShadowStoreForTests(store: SessionStore | null): void {
  injectedStore = store
}

/** Test-only: clear buffers/timers. */
export function __resetShadowWriterForTests(): void {
  states.clear()
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushChain = Promise.resolve()
}
