/**
 * Phase A shadow writer tests.
 *
 * Verifies the write-side mirror: appends that land in the JSONL also land in
 * SQLite, with incremental appends guarded so they can never diverge from a
 * full parse, and with every failure mode falling back to (or leaving room
 * for) the read-through self-heal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './SessionStore.js'
import {
  shadowAppendBatch,
  flushShadowWrites,
  flushShadowWritesSync,
  shadowReconcileSession,
  __setShadowStoreForTests,
  __resetShadowWriterForTests,
} from './shadowWriter.js'
import type { Entry } from '../../types/logs.js'

const S1 = '00000000-0000-4000-8000-0000000000a1'

function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function user(n: number, parent: string | null, content: string): Entry {
  return {
    parentUuid: parent,
    isSidechain: false,
    uuid: uid(n),
    timestamp: new Date(1700000000000 + n).toISOString(),
    type: 'user',
    sessionId: S1,
    message: { role: 'user', content },
  } as unknown as Entry
}

function boundary(n: number): Entry {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date(1700000000000 + n).toISOString(),
    uuid: uid(n),
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 1000 },
  } as unknown as Entry
}

describe('shadowWriter (Phase A dual-write)', () => {
  let dir: string
  let store: SessionStore
  let jsonl: string
  let authSeq = 1000

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-writer-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.TEST_ENABLE_SHADOW_WRITER = '1'
    mkdirSync(join(dir, 'projects', 'proj'), { recursive: true })
    jsonl = join(dir, 'projects', 'proj', `${S1}.jsonl`)
    store = SessionStore.open(join(dir, 'store.db'))
    __setShadowStoreForTests(store)
    __resetShadowWriterForTests()
  })

  afterEach(() => {
    __setShadowStoreForTests(null)
    __resetShadowWriterForTests()
    delete process.env.TEST_ENABLE_SHADOW_WRITER
    delete process.env.CLAUDE_CONFIG_DIR
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Append through the real file-write + shadow seam (same contract as the
   *  call sites: file write first, then shadowAppendBatch with exact bytes). */
  function appendMirrored(entry: Entry): void {
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(jsonl, line)
    shadowAppendBatch(jsonl, [entry], Buffer.byteLength(line))
  }

  /** Write to the file WITHOUT the shadow (foreign-writer simulation). */
  function appendForeign(entry: Entry): void {
    appendFileSync(jsonl, JSON.stringify(entry) + '\n')
  }

  it('is disabled by default in test env (no DB writes)', async () => {
    delete process.env.TEST_ENABLE_SHADOW_WRITER
    appendFileSync(jsonl, JSON.stringify(user(1, null, 'x')) + '\n')
    shadowAppendBatch(jsonl, [user(1, null, 'x')], 10)
    await flushShadowWrites()
    expect(store.getSession(S1)).toBeNull()
  })

  it('mirrors appends and reconciles with loadTranscriptFile', async () => {
    appendMirrored(user(1, null, 'one'))
    appendMirrored(user(2, uid(1), 'two'))
    await flushShadowWrites()

    // First flush = full resync (expectedSize unknown) → canonical rows.
    expect(store.getSession(S1)?.messageCount).toBe(2)
    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
  })

  it('incremental append path stays canonical (second flush onwards)', async () => {
    appendMirrored(user(1, null, 'one'))
    await flushShadowWrites()

    // These batches go through the guarded incremental append.
    appendMirrored(user(2, uid(1), 'two'))
    appendMirrored(user(3, uid(2), 'three'))
    await flushShadowWrites()

    expect(store.getSession(S1)?.messageCount).toBe(3)
    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
  })

  it('metadata appends (no uuid) are mirrored and reconcile', async () => {
    appendMirrored(user(1, null, 'one'))
    await flushShadowWrites()

    const title: Entry = {
      type: 'custom-title',
      customTitle: 'Shadow Title',
      sessionId: S1,
    } as unknown as Entry
    appendMirrored(title)
    await flushShadowWrites()

    const shape = store.loadTranscript(S1)
    expect([...shape.customTitles.values()]).toEqual(['Shadow Title'])
    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
  })

  it('a compact boundary forces a full resync (never incremental)', async () => {
    appendMirrored(user(1, null, 'pre'))
    appendMirrored(user(2, uid(1), 'pre2'))
    await flushShadowWrites()

    appendMirrored(boundary(900))
    appendMirrored(user(3, uid(900), 'post'))
    await flushShadowWrites()

    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
  })

  it('foreign appends poison the size guard → full resync, never divergence', async () => {
    appendMirrored(user(1, null, 'one'))
    await flushShadowWrites()

    // Another process appends directly to the file (no shadow).
    appendForeign(user(99, uid(1), 'foreign'))

    // Our next shadow append must not go incremental (file size disproves
    // "canonical prefix + our bytes") — it falls back to a full resync that
    // picks up the foreign entry too.
    appendMirrored(user(2, uid(1), 'two'))
    await flushShadowWrites()

    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
    const shape = store.loadTranscript(S1)
    expect(shape.messages.has(uid(99) as never)).toBe(true)
    expect(shape.messages.has(uid(2) as never)).toBe(true)
  })

  it('rows replaced behind the writer’s back → last-row guard resyncs', async () => {
    appendMirrored(user(1, null, 'one'))
    await flushShadowWrites()

    // A reader-path resync (or another writer) replaced/added rows.
    appendForeign(user(50, uid(1), 'sneaky'))
    await flushShadowWrites() // flush does nothing: buffer empty
    // Manually sync rows from the file to simulate the concurrent reader.
    const { loadTranscriptCached } = await import('./transcriptCache.js')
    await loadTranscriptCached(store, S1, jsonl, 'proj')

    // Our writer's last-row token no longer matches → next incremental append
    // must fall back, not duplicate or diverge.
    appendMirrored(user(2, uid(1), 'two'))
    await flushShadowWrites()

    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
    const shape = store.loadTranscript(S1)
    expect(shape.messages.size).toBe(3) // one, sneaky, two
  })

  it('flushShadowWritesSync updates rows incrementally (exit path)', async () => {
    appendMirrored(user(1, null, 'one'))
    await flushShadowWrites()

    appendMirrored(user(2, uid(1), 'two'))
    flushShadowWritesSync() // no await — the exit-path contract

    expect(store.loadTranscript(S1).messages.size).toBe(2)
    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
  })

  it('skips subagent transcript paths', async () => {
    const agentPath = join(dir, 'projects', 'proj', S1, 'subagents', 'agent-x.jsonl')
    mkdirSync(join(dir, 'projects', 'proj', S1, 'subagents'), { recursive: true })
    const line = JSON.stringify(user(1, null, 'agent')) + '\n'
    appendFileSync(agentPath, line)
    shadowAppendBatch(agentPath, [user(1, null, 'agent')], Buffer.byteLength(line))
    await flushShadowWrites()

    expect(store.getLastMessageUuid('agent-x')).toBeNull()
  })

  it('missing file during flush → buffer dropped, no throw', async () => {
    appendMirrored(user(1, null, 'one'))
    await flushShadowWrites()
    appendMirrored(user(2, uid(1), 'two'))
    rmSync(jsonl, { force: true })

    await expect(flushShadowWrites()).resolves.toBeUndefined()
    // Rows remain from before; a later read of a recreated file self-heals.
    expect(store.getSession(S1)).not.toBeNull()
  })

  it('empty file written before first flush still reconciles', async () => {
    // File exists but is empty → parse yields no entries → no session row,
    // then normal appends take over.
    writeFileSync(jsonl, '')
    appendMirrored(user(1, null, 'one'))
    await flushShadowWrites()
    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
  })

  it('crossing the 5MB precompact threshold forces a full resync', async () => {
    // Build a file just under the threshold via pad content, sync, then
    // append a batch that pushes it over — the guard must refuse incremental
    // (reader pruning gates change at the threshold).
    const big = 'x'.repeat(4_900_000)
    appendMirrored(user(1, null, big))
    await flushShadowWrites()

    appendMirrored(user(2, uid(1), 'y'.repeat(300_000)))
    await flushShadowWrites()

    expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
  })

  it('end-to-end: real append seams (async queue + sync) mirror into SQLite', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    try {
      const {
        resetProjectForTesting,
        setSessionFileForTesting,
        recordFileHistorySnapshot,
        saveCustomTitle,
        flushSessionStorage,
      } = await import('../../utils/sessionStorage.js')

      resetProjectForTesting()
      setSessionFileForTesting(jsonl)

      // Async queue seam: appendEntry → enqueueWrite → drainWriteQueue → shadow
      await recordFileHistorySnapshot('00000000-0000-4000-8000-0000000000f1' as never, { commits: [] } as never, false)
      await flushSessionStorage()

      // Sync seam: appendEntryToFile → shadow
      await saveCustomTitle(S1 as never, 'E2E Title', jsonl)

      await flushShadowWrites()

      expect(await shadowReconcileSession(store, jsonl)).toEqual({ ok: true })
      const shape = store.loadTranscript(S1)
      expect([...shape.customTitles.values()]).toEqual(['E2E Title'])
      expect(shape.fileHistorySnapshots.size).toBe(1)
    } finally {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
      const { resetProjectForTesting } = await import('../../utils/sessionStorage.js')
      resetProjectForTesting()
    }
  })
})
