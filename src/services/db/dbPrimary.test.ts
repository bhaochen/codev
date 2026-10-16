/**
 * D1 (DB-primary) tests.
 *
 * In primary mode SQLite is the authoritative store:
 *  - reads serve rows whenever they exist — a lagging/short/missing export
 *    file must NOT roll rows back;
 *  - sessions with no rows bootstrap from the file once;
 *  - the drain seam writes rows first (mandatory) and the file second
 *    (best-effort export);
 *  - a failed export is repaired from the rows (full-file rewrite).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionStore,
  __resetSessionStoreForTests,
  getSessionStore,
} from './SessionStore.js'
import { loadTranscriptCached } from './transcriptCache.js'
import {
  flushShadowWrites,
  shadowAppendBatch,
  __setShadowStoreForTests,
  __resetShadowWriterForTests,
} from './shadowWriter.js'
import type { Entry } from '../../types/logs.js'

const S1 = '00000000-0000-4000-8000-0000000000f1'

function user(n: number, parent: string | null, content: string): Entry {
  return {
    parentUuid: parent,
    isSidechain: false,
    uuid: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    timestamp: new Date(1700000000000 + n).toISOString(),
    type: 'user',
    sessionId: S1,
    cwd: '/proj',
    gitBranch: 'main',
    message: { role: 'user', content },
  } as unknown as Entry
}

function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

describe('D1 DB-primary mode', () => {
  let dir: string
  let store: SessionStore
  let jsonl: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-primary-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    mkdirSync(join(dir, 'projects', 'proj'), { recursive: true })
    jsonl = join(dir, 'projects', 'proj', `${S1}.jsonl`)

    process.env.CODEV_DB_PRIMARY = '1'
    process.env.TEST_ENABLE_SHADOW_WRITER = '1'
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    // These tests cover the eager-export/repair machinery (D3 semantics),
    // which D4 made opt-in: the default now defers the file until an external
    // reader asks for it (see exportDeferral.test.ts).
    process.env.CODEV_SESSION_EXPORT = '1'

    __resetSessionStoreForTests()
    store = getSessionStore() // same singleton the repair path uses
    __setShadowStoreForTests(store)
    __resetShadowWriterForTests()
  })

  afterEach(() => {
    __setShadowStoreForTests(null)
    __resetShadowWriterForTests()
    __resetSessionStoreForTests()
    delete process.env.CODEV_DB_PRIMARY
    delete process.env.TEST_ENABLE_SHADOW_WRITER
    delete process.env.TEST_ENABLE_TRANSCRIPT_CACHE
    delete process.env.CODEV_SESSION_EXPORT
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('rows are authoritative: reads ignore a stale/short export file', async () => {
    // v1 lands in rows + file.
    writeFileSync(jsonl, JSON.stringify(user(1, null, 'v1')) + '\n')
    await loadTranscriptCached(store, S1, jsonl, 'proj')

    // v2 arrives via the primary write path (rows only — file deleted below).
    rmSync(jsonl)
    shadowAppendBatch(jsonl, [user(2, uid(1), 'v2')], 10)
    await flushShadowWrites()

    // File is still missing; rows now carry both entries. A file-anchored
    // reader would throw/resync-to-nothing; the primary rule serves rows.
    expect(existsSync(jsonl)).toBe(false)
    const shape = await loadTranscriptCached(store, S1, jsonl, 'proj')
    expect(shape.messages.size).toBe(2)
    expect(shape.messages.has(uid(2) as never)).toBe(true)
  })

  it('bootstraps from the file when the session has no rows yet', async () => {
    writeFileSync(jsonl, JSON.stringify(user(1, null, 'legacy')) + '\n')
    expect(store.getMessageCount(S1)).toBe(0)

    const shape = await loadTranscriptCached(store, S1, jsonl, 'proj')
    expect(shape.messages.size).toBe(1)
    // Bootstrap synced the rows; the next read is row-served.
    expect(store.getMessageCount(S1)).toBe(1)
    rmSync(jsonl)
    const again = await loadTranscriptCached(store, S1, jsonl, 'proj')
    expect(again.messages.size).toBe(1)
  })

  it('drain seam writes rows first and the file as export', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    try {
      const {
        resetProjectForTesting,
        setSessionFileForTesting,
        recordFileHistorySnapshot,
        flushSessionStorage,
      } = await import('../../utils/sessionStorage.js')

      resetProjectForTesting()
      setSessionFileForTesting(jsonl)

      await recordFileHistorySnapshot(
        '00000000-0000-4000-8000-0000000000a1' as never,
        { commits: [] } as never,
        false,
      )
      await flushSessionStorage()

      // Rows: present (mandatory path).
      expect(store.getMessageCount(S1)).toBe(1)
      // Export: the file received the same entry.
      expect(existsSync(jsonl)).toBe(true)
      expect(readFileSync(jsonl, 'utf-8')).toContain('file-history-snapshot')

      resetProjectForTesting()
    } finally {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    }
  })

  it('a lagging export (file lost, partial rewrite) never rolls rows back', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    try {
      const {
        resetProjectForTesting,
        setSessionFileForTesting,
        recordFileHistorySnapshot,
        flushSessionStorage,
      } = await import('../../utils/sessionStorage.js')

      resetProjectForTesting()
      setSessionFileForTesting(jsonl)

      await recordFileHistorySnapshot(
        '00000000-0000-4000-8000-0000000000a1' as never,
        { commits: [] } as never,
        false,
      )
      await flushSessionStorage()

      // Export file vanishes; the next write recreates it with ONLY the new
      // entry (export lag — it is missing history the rows still hold).
      rmSync(jsonl)
      await recordFileHistorySnapshot(
        '00000000-0000-4000-8000-0000000000a2' as never,
        { commits: [] } as never,
        false,
      )
      await flushSessionStorage()

      const fileLines = readFileSync(jsonl, 'utf-8').trim().split('\n').length
      expect(fileLines).toBe(1) // lagging export: only the recreated entry

      // Reads must serve the complete rows (2 snapshots), not the file.
      const shape = await loadTranscriptCached(store, S1, jsonl, 'proj')
      expect(shape.fileHistorySnapshots.size).toBe(2)

      resetProjectForTesting()
    } finally {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    }
  })

  it('repairs a failed export from the rows (full rewrite)', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    try {
      const {
        resetProjectForTesting,
        setSessionFileForTesting,
        recordFileHistorySnapshot,
        flushSessionStorage,
      } = await import('../../utils/sessionStorage.js')

      resetProjectForTesting()
      setSessionFileForTesting(jsonl)

      await recordFileHistorySnapshot(
        '00000000-0000-4000-8000-0000000000a1' as never,
        { commits: [] } as never,
        false,
      )
      await flushSessionStorage()
      expect(readFileSync(jsonl, 'utf-8').trim().split('\n').length).toBe(1)

      // Make the export append fail (file unwritable). The parent dir is
      // still writable, so the repair's tmp+rename can replace it.
      chmodSync(jsonl, 0o000)
      await recordFileHistorySnapshot(
        '00000000-0000-4000-8000-0000000000a2' as never,
        { commits: [] } as never,
        false,
      )
      await flushSessionStorage()

      // Rows mandatory: both entries present regardless of the export state.
      expect(store.getMessageCount(S1)).toBe(2)

      // Repair is fire-and-forget — poll briefly for the rewritten file.
      let repaired = false
      for (let i = 0; i < 50 && !repaired; i++) {
        await new Promise(r => setTimeout(r, 20))
        try {
          chmodSync(jsonl, 0o600)
          const lines = readFileSync(jsonl, 'utf-8').trim().split('\n').length
          repaired = lines === 2
        } catch {
          // not yet repaired
        }
      }
      expect(repaired).toBe(true)
      expect(readFileSync(jsonl, 'utf-8')).toContain('file-history-snapshot')

      resetProjectForTesting()
    } finally {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    }
  })

  it('forks from rows when the export file lags or is missing (C5)', async () => {
    // Source chain synced to rows (bootstrap path).
    writeFileSync(
      jsonl,
      [user(1, null, 'hello'), user(2, uid(1), 'world')]
        .map(e => JSON.stringify(e))
        .join('\n') + '\n',
    )
    await loadTranscriptCached(store, S1, jsonl, 'proj')

    // A newer entry lands in rows only, then the export file is lost —
    // exactly the lagging-export state a fork must survive.
    shadowAppendBatch(jsonl, [user(3, uid(2), 'newest')], 1)
    await flushShadowWrites()
    rmSync(jsonl)
    expect(existsSync(jsonl)).toBe(false)

    const { createSessionBranch } = await import('../../utils/sessionBranching.js')
    const branch = await createSessionBranch({
      sourceSessionId: S1,
      sourceTranscriptPath: jsonl,
      title: 'Fork',
    })

    const forkPath = join(dir, 'projects', 'proj', `${branch.sessionId}.jsonl`)
    expect(existsSync(forkPath)).toBe(true)
    const forkEntries = readFileSync(forkPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type?: string; uuid?: string })
    const forkedMessageUuids = forkEntries
      .filter(e => e.type === 'user')
      .map(e => e.uuid)
    // All three source messages copied from the rows, in chain order.
    expect(forkedMessageUuids).toEqual([uid(1), uid(2), uid(3)])
  })

  it('lists DB-only sessions when the projects tree is gone (C6)', async () => {
    // The listing queries getProjectDir(originalCwd) — put the rows there.
    const { getProjectDir, getProjectsDir } = await import(
      '../../utils/sessionStoragePortable.js'
    )
    const { getOriginalCwd } = await import('../../bootstrap/state.js')
    const { relative } = await import('node:path')
    const listingProjDir = getProjectDir(getOriginalCwd())
    const relProject = relative(getProjectsDir(), listingProjDir)

    // Rows only — no JSONL file exists at all, and no lastPrompt either
    // (the custom-title must still resolve with the file gone).
    store.syncSession(S1, relProject, [
      user(1, null, 'listed from db'),
      { type: 'custom-title', customTitle: 'DB-only title', sessionId: S1 } as unknown as Entry,
    ])
    store.markSessionPrimaryOwned(S1)

    // The whole projects tree vanishes (files are just exports).
    rmSync(join(dir, 'projects'), { recursive: true, force: true })

    const { loadMessageLogs } = await import('../../utils/sessionStorage.js')
    const logs = await loadMessageLogs(50)
    const entry = logs.find(l => l.sessionId === S1)
    expect(entry).toBeDefined()
    expect(entry?.customTitle).toBe('DB-only title')
  })

  it('default/gate semantics: tests opt in, explicit 0 disables', async () => {
    const { isDbPrimaryMode } = await import('../../utils/sessionPersistence.js')
    // Test env default: OFF (hermetic suite).
    delete process.env.CODEV_DB_PRIMARY
    expect(isDbPrimaryMode()).toBe(false)
    // Empty string counts as unset.
    process.env.CODEV_DB_PRIMARY = ''
    expect(isDbPrimaryMode()).toBe(false)
    delete process.env.CODEV_DB_PRIMARY
    // Explicit values win in every env.
    process.env.CODEV_DB_PRIMARY = '1'
    expect(isDbPrimaryMode()).toBe(true)
    process.env.CODEV_DB_PRIMARY = '0'
    expect(isDbPrimaryMode()).toBe(false)
    process.env.CODEV_DB_PRIMARY = 'false'
    expect(isDbPrimaryMode()).toBe(false)
    process.env.CODEV_DB_PRIMARY = '1' // restore for afterEach semantics
  })

  it('unmarked legacy rows with the file present still self-heal from the file', async () => {
    // Legacy-shaped row: rows exist but were never primary-written and carry
    // no sync info (pre-v4 state, simulated).
    store.syncSession(S1, 'proj', [user(1, null, 'v1')])
    expect(store.isSessionPrimaryOwned(S1)).toBe(false)

    // The file is ahead of the rows (the legacy source of truth).
    writeFileSync(
      jsonl,
      [user(1, null, 'v1'), user(2, uid(1), 'v2')]
        .map(e => JSON.stringify(e))
        .join('\n') + '\n',
    )

    const shape = await loadTranscriptCached(store, S1, jsonl, 'proj')
    // The stale path resynced from the file — no rollback, no loss.
    expect(shape.messages.size).toBe(2)
    expect(store.getMessageCount(S1)).toBe(2)
  })

  it('flag off restores file-first ordering (shadow mirror still runs)', async () => {
    delete process.env.CODEV_DB_PRIMARY
    writeFileSync(jsonl, JSON.stringify(user(1, null, 'v1')) + '\n')

    shadowAppendBatch(jsonl, [user(2, uid(1), 'v2')], 999)
    await flushShadowWrites()
    // Shadow path requires file-anchored consistency; a bogus byte count
    // forces the resync from the file (file has only v1 — rows follow file).
    const shape = store.loadTranscript(S1)
    expect(shape.messages.size).toBe(1)
  })
})
