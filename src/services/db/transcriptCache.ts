/**
 * Read-through SQLite transcript cache.
 *
 * Serves a session's transcript from SQLite, syncing from the JSONL source
 * first when stale. JSONL remains the source of truth (safe, rebuildable);
 * SQLite is a derived mirror. Because the sync runs at READ time, it is
 * correct regardless of which code path last wrote the JSONL — the main
 * append queue, the metadata re-append, a fork's whole-file copy, speculation,
 * or the server. No write seam can be missed and leave a stale read, which is
 * why this beats hooking each writer for a dual-write mirror.
 *
 * Staleness decision (live file stat vs the last-synced stat, from migration
 * 002's synced_size/synced_mtime + 003's synced_path):
 *   - never synced, a different source path, size changed (append, compaction
 *     or rewrite), or mtime moved → full re-sync via syncSession;
 *   - unchanged → serve SQLite directly with no JSONL parse — the perf win
 *     that makes large-session resume cheap.
 *
 * Fidelity by construction: the sync parses via `parseTranscriptFile`, the
 * SAME file-read pipeline loadTranscriptFile uses (fd-level attr-snap skip,
 * compact-boundary truncation, pre-boundary metadata recovery, walkChain
 * pruning), and stores the two reducer input lists with their roles
 * (main/meta). Reading back through buildTranscriptShape therefore produces
 * exactly what loadTranscriptFile would have — including on files over
 * SKIP_PRECOMPACT_THRESHOLD containing compact boundaries, where a naive
 * full-file read would diverge (pre-boundary messages and dead fork branches
 * would leak into the shape).
 *
 * The cache mirrors default-opts reads (keepAllLeaves unset, no
 * CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP): both are process-lifetime-stable in
 * practice, and callers with non-default opts (e.g. /insights) must not be
 * served from it.
 *
 * A stat/read race is self-healing: we store the pre-read stat, so if the
 * file is appended between statSync and the parse, the next load sees a size
 * or mtime mismatch and re-syncs. We never mark a session fresh for bytes we
 * did not actually read.
 */
import { statSync, realpathSync } from 'node:fs'
import { parseTranscriptFile, type TranscriptShape } from '../../utils/sessionStorage.js'
import type { SessionStore } from './SessionStore.js'

export async function loadTranscriptCached(
  store: SessionStore,
  sessionId: string,
  jsonlPath: string,
  projectDir: string,
): Promise<TranscriptShape> {
  // stat first: a missing file throws here, and callers fall back to the
  // direct JSONL read (which returns the same empty shape it always did).
  const st = statSync(jsonlPath)
  // realpath: one session can be addressed by different path strings
  // (sessionProjectDir vs a listing's fullPath, symlinked homes). Freshness
  // must compare canonical paths or every alternating call site would
  // re-sync from scratch.
  const resolvedPath = realpathSync(jsonlPath)
  const sync = store.getSyncInfo(sessionId)

  const fresh =
    sync !== null &&
    sync.path === resolvedPath &&
    sync.size === st.size &&
    sync.mtime === Math.trunc(st.mtimeMs)

  if (fresh) {
    const shape = store.loadTranscript(sessionId)
    // Self-heal: marked fresh but no transcript rows while the source file has
    // content (external deletion / partial restore) → never serve empty.
    // Metadata-only files re-sync on each read — cheap (tiny file), correct.
    if (st.size === 0 || shape.messages.size > 0) return shape
  }

  // Stale (or healed): parse via the canonical pipeline, store, then serve
  // the stored rows — exercising the same read path the fresh case uses.
  const { mainEntries, metadataEntries } = await parseTranscriptFile(jsonlPath)
  store.syncSession(sessionId, projectDir, mainEntries, metadataEntries)
  store.setSyncInfo(sessionId, st.size, Math.trunc(st.mtimeMs), resolvedPath)
  return store.loadTranscript(sessionId)
}
