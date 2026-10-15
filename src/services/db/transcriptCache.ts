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
 * 002's synced_size/synced_mtime):
 *   - never synced, size shrank (compaction/rewrite), or mtime moved → full
 *     re-sync via syncSession (replaces rows, full fidelity);
 *   - unchanged → serve SQLite directly with no JSONL parse — the perf win
 *     that makes large-session resume cheap.
 *
 * A stat/read race is self-healing: if the file is appended between statSync
 * and readFileSync, we store the pre-read stat, so the next load sees a size
 * mismatch and re-syncs. We never mark a session fresh for bytes we did not
 * actually read.
 */
import { statSync, readFileSync } from 'node:fs'
import { parseJSONL } from '../../utils/json.js'
import type { TranscriptShape } from '../../utils/sessionStorage.js'
import type { SessionStore } from './SessionStore.js'
import type { Entry } from '../../types/logs.js'

export function loadTranscriptCached(
  store: SessionStore,
  sessionId: string,
  jsonlPath: string,
  projectDir: string,
): TranscriptShape {
  const st = statSync(jsonlPath)
  const sync = store.getSyncInfo(sessionId)

  const fresh =
    sync !== null &&
    sync.size === st.size &&
    sync.mtime === Math.trunc(st.mtimeMs)

  if (!fresh) {
    const entries = parseJSONL<Entry>(readFileSync(jsonlPath))
    store.syncSession(sessionId, projectDir, entries)
    store.setSyncInfo(sessionId, st.size, Math.trunc(st.mtimeMs))
  }

  return store.loadTranscript(sessionId)
}
