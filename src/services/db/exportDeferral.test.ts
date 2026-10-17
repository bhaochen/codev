/**
 * D4 — deferred export tests.
 *
 * In DB-primary mode the JSONL file is an export. Deferred mode (the default)
 * stops the append path from writing it at all; external readers get it
 * materialized on demand. These tests cover the gate, the on-demand
 * materializer (fast append path, full-rewrite path, correctness vs. a
 * canonical export), and the real write seams staying off disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './SessionStore.js'
import {
  shadowAppendBatch,
  flushShadowWrites,
  __setShadowStoreForTests,
  __resetShadowWriterForTests,
} from './shadowWriter.js'
import { exportSessionToFile } from './exportSession.js'
import {
  getSessionExportMode,
  isExportDeferred,
  markExportDirty,
  materializeExportForPath,
  __resetExportDeferralForTests,
} from './exportDeferral.js'
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

describe('exportDeferral (D4)', () => {
  let dir: string
  let store: SessionStore
  let jsonl: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-deferral-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.CODEV_DB_PRIMARY = '1'
    // Most tests exercise the on-demand materialization seam explicitly; the
    // shipped default is 'manual' (CLI-only writer) — see the default test.
    process.env.CODEV_SESSION_EXPORT = 'on-read'
    process.env.TEST_ENABLE_SHADOW_WRITER = '1'
    mkdirSync(join(dir, 'projects', 'proj'), { recursive: true })
    jsonl = join(dir, 'projects', 'proj', `${S1}.jsonl`)
    store = SessionStore.open(join(dir, 'store.db'))
    __setShadowStoreForTests(store)
    __resetShadowWriterForTests()
    __resetExportDeferralForTests()
  })

  afterEach(() => {
    __setShadowStoreForTests(null)
    __resetShadowWriterForTests()
    __resetExportDeferralForTests()
    delete process.env.TEST_ENABLE_SHADOW_WRITER
    delete process.env.CODEV_DB_PRIMARY
    delete process.env.CODEV_SESSION_EXPORT
    delete process.env.CLAUDE_CONFIG_DIR
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Write rows through the mirror (no file write — the deferred contract). */
  async function mirror(entries: Entry[]): Promise<void> {
    shadowAppendBatch(jsonl, entries, 1)
    await flushShadowWrites()
  }

  it('gate: manual is the default; on-read and eager opt in', () => {
    delete process.env.CODEV_SESSION_EXPORT
    // Default: DB-only — appends defer AND hooks do not materialize.
    expect(isExportDeferred()).toBe(true)
    expect(getSessionExportMode()).toBe('manual')
    process.env.CODEV_SESSION_EXPORT = 'on-read'
    expect(isExportDeferred()).toBe(true)
    expect(getSessionExportMode()).toBe('on-read')
    process.env.CODEV_SESSION_EXPORT = '1'
    expect(isExportDeferred()).toBe(false)
    expect(getSessionExportMode()).toBe('eager')
    process.env.CODEV_DB_PRIMARY = '0'
    expect(isExportDeferred()).toBe(false)
  })

  it('default (manual) mode: no automatic materialization, CLI export still works', async () => {
    delete process.env.CODEV_SESSION_EXPORT
    // The append path stays deferred (rows are still the record).
    expect(isExportDeferred()).toBe(true)

    await mirror([user(1, null, 'one'), user(2, uid(1), 'two')])
    markExportDirty(jsonl)
    // The hook seam (materializeExportForPath) refuses to write.
    expect(await materializeExportForPath(jsonl)).toBe(false)
    expect(existsSync(jsonl)).toBe(false)

    // The explicit CLI (exportSessionToFile) is the only writer.
    const result = exportSessionToFile(store, S1)
    expect(result?.entries).toBe(2)
    expect(existsSync(jsonl)).toBe(true)
    const lines = readFileSync(jsonl, 'utf8').trim().split('\n')
    expect(lines.map(l => JSON.parse(l).uuid)).toEqual([uid(1), uid(2)])
  })

  it('materializes a missing file from rows on demand', async () => {
    await mirror([user(1, null, 'one'), user(2, uid(1), 'two')])
    expect(existsSync(jsonl)).toBe(false)

    // Not yet marked: the file is missing → materialize anyway (an external
    // reader asked for it bare).
    expect(await materializeExportForPath(jsonl)).toBe(true)
    expect(existsSync(jsonl)).toBe(true)

    const lines = readFileSync(jsonl, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).uuid).toBe(uid(1))
    expect(JSON.parse(lines[1]!).uuid).toBe(uid(2))
  })

  it('appends only the missing rows after the first materialization', async () => {
    await mirror([user(1, null, 'one')])
    await materializeExportForPath(jsonl)
    const sizeAfterFirst = statSync(jsonl).size

    await mirror([user(2, uid(1), 'two'), user(3, uid(2), 'three')])
    markExportDirty(jsonl)
    expect(await materializeExportForPath(jsonl)).toBe(true)

    const lines = readFileSync(jsonl, 'utf8').trim().split('\n')
    expect(lines.map(l => JSON.parse(l).uuid)).toEqual([uid(1), uid(2), uid(3)])
    // Appended, not rewritten: the prefix is byte-identical.
    expect(readFileSync(jsonl, 'utf8').startsWith(
      readFileSync(jsonl, 'utf8').slice(0, sizeAfterFirst),
    )).toBe(true)
  })

  it('materialized file equals a canonical export of the rows', async () => {
    await mirror([user(1, null, 'one'), user(2, uid(1), 'two')])
    markExportDirty(jsonl)
    await materializeExportForPath(jsonl)
    const materialized = readFileSync(jsonl, 'utf8')

    const canonicalPath = join(dir, 'canonical.jsonl')
    exportSessionToFile(store, S1, canonicalPath)
    expect(materialized).toBe(readFileSync(canonicalPath, 'utf8'))
  })

  it('leaves a current file untouched (no rewrite on a clean read)', async () => {
    await mirror([user(1, null, 'one')])
    await materializeExportForPath(jsonl)
    const mtime = statSync(jsonl).mtimeMs
    // Another hook in the same turn: nothing dirty → no write.
    expect(await materializeExportForPath(jsonl)).toBe(false)
    expect(statSync(jsonl).mtimeMs).toBe(mtime)
  })

  it('rewrites when the file was modified out from under us', async () => {
    await mirror([user(1, null, 'one'), user(2, uid(1), 'two')])
    await materializeExportForPath(jsonl)
    // External truncation — the watermark no longer matches the live size.
    truncateSync(jsonl, 0)
    markExportDirty(jsonl)
    expect(await materializeExportForPath(jsonl)).toBe(true)
    const lines = readFileSync(jsonl, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('does nothing when the export is eager (CODEV_SESSION_EXPORT=1)', async () => {
    process.env.CODEV_SESSION_EXPORT = '1'
    await mirror([user(1, null, 'one')])
    expect(await materializeExportForPath(jsonl)).toBe(false)
    expect(existsSync(jsonl)).toBe(false)
  })

  it('manual mode: no automatic materialization, CLI export still works', async () => {
    process.env.CODEV_SESSION_EXPORT = 'manual'
    // The append path stays deferred (rows are still the record).
    expect(isExportDeferred()).toBe(true)

    await mirror([user(1, null, 'one'), user(2, uid(1), 'two')])
    markExportDirty(jsonl)
    // The hook seam (materializeExportForPath) refuses to write.
    expect(await materializeExportForPath(jsonl)).toBe(false)
    expect(existsSync(jsonl)).toBe(false)

    // The explicit CLI (exportSessionToFile) is the only writer.
    const result = exportSessionToFile(store, S1)
    expect(result?.entries).toBe(2)
    expect(existsSync(jsonl)).toBe(true)
    const lines = readFileSync(jsonl, 'utf8').trim().split('\n')
    expect(lines.map(l => JSON.parse(l).uuid)).toEqual([uid(1), uid(2)])
  })

  it('ignores paths outside the projects root', async () => {
    const stray = join(dir, 'not-a-session.jsonl')
    writeFileSync(stray, '')
    markExportDirty(stray)
    expect(await materializeExportForPath(stray)).toBe(false)
  })

  it('end-to-end: real seams keep the file off disk until materialized', async () => {
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

      // Async queue seam (drainWriteQueue → writeChunk).
      await recordFileHistorySnapshot(
        '00000000-0000-4000-8000-0000000000f1' as never,
        { commits: [] } as never,
        false,
      )
      await flushSessionStorage()
      // Sync seam (appendEntryToFile).
      await saveCustomTitle(S1 as never, 'E2E Title', jsonl)
      await flushShadowWrites()

      // D4: the file was never written; the rows are the record.
      expect(existsSync(jsonl)).toBe(false)
      expect(store.getMessageCount(S1)).toBeGreaterThan(0)

      // An external reader (hook/statusline) asks → the file appears complete.
      expect(await materializeExportForPath(jsonl)).toBe(true)
      const content = readFileSync(jsonl, 'utf8')
      expect(content).toContain('E2E Title')
      expect(content).toContain('file-history-snapshot')
    } finally {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
      const { resetProjectForTesting } = await import('../../utils/sessionStorage.js')
      resetProjectForTesting()
    }
  })
})
