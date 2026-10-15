/**
 * DB → JSONL export / repair tests.
 *
 * The export must reconstruct a file that parses back to EXACTLY the
 * canonical view of the DB rows: small files (everything in order) and large
 * files (boundary truncation + [0,boundary) metadata byte scan) alike. And a
 * canonical-path export must refresh sync info so the cache serves it fresh.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { SessionStore } from './SessionStore.js'
import { loadTranscriptCached } from './transcriptCache.js'
import { exportSessionToFile } from './exportSession.js'
import { loadTranscriptFile } from '../../utils/sessionStorage.js'
import { getProjectsDir } from '../../utils/sessionStoragePortable.js'
import type { Entry } from '../../types/logs.js'

const S = '00000000-0000-4000-8000-0000000000e1'

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
    sessionId: S,
    cwd: '/proj',
    gitBranch: 'main',
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

function normalize(shape: {
  messages: Map<string, unknown>
  summaries: Map<string, unknown>
  customTitles: Map<string, unknown>
  tags: Map<string, unknown>
  leafUuids: Set<string>
}): string {
  const m = (map: Map<string, unknown>) => Object.fromEntries(map)
  return JSON.stringify({
    messages: m(shape.messages),
    summaries: m(shape.summaries),
    customTitles: m(shape.customTitles),
    tags: m(shape.tags),
    leafUuids: [...shape.leafUuids].sort(),
  })
}

describe('exportSession (DB → JSONL repair/backup)', () => {
  let dir: string
  let store: SessionStore
  let jsonl: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-session-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    jsonl = join(dir, 'projects', 'proj', `${S}.jsonl`)
    mkdirSync(join(dir, 'projects', 'proj'), { recursive: true })
    store = SessionStore.open(join(dir, 'store.db'))
  })

  afterEach(() => {
    store.close()
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  function writeFixture(entries: Entry[]): void {
    writeFileSync(jsonl, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  }

  it('round-trips a small session: exported file ≡ DB shape', async () => {
    writeFixture([
      user(1, null, 'one'),
      { type: 'custom-title', customTitle: 'T', sessionId: S } as unknown as Entry,
      user(2, uid(1), 'two'),
    ])
    await loadTranscriptCached(store, S, jsonl, relative(getProjectsDir(), join(dir, 'projects', 'proj')))

    const out = join(dir, 'exported.jsonl')
    const result = exportSessionToFile(store, S, out)
    expect(result).not.toBeNull()
    expect(result!.entries).toBe(3)

    const fromExported = await loadTranscriptFile(out)
    const fromDb = store.loadTranscript(S)
    expect(normalize(fromExported)).toEqual(normalize(fromDb))
  })

  it('round-trips a large compacted session (meta-first layout survives the boundary scan)', async () => {
    const pre: Entry[] = []
    for (let i = 0; i < 6; i++) {
      pre.push(user(100 + i, i === 0 ? null : uid(99 + i), 'p'.repeat(900 * 1024)))
    }
    pre.push({ type: 'custom-title', customTitle: 'Pre Title', sessionId: S } as unknown as Entry)
    pre.push({ type: 'last-prompt', lastPrompt: 'hello', sessionId: S } as unknown as Entry)
    const b1 = boundary(9000)
    const post = [user(200, uid(9000), 'q'.repeat(500 * 1024)), user(201, uid(200), 'done')]
    writeFixture([...pre, b1, ...post])

    await loadTranscriptCached(store, S, jsonl, relative(getProjectsDir(), join(dir, 'projects', 'proj')))

    const out = join(dir, 'exported-large.jsonl')
    const result = exportSessionToFile(store, S, out)
    expect(result).not.toBeNull()

    // The exported file is >5MB with a boundary → the reader truncates and
    // byte-scans [0,boundary) for metadata. The export must reduce to the
    // same shape as the DB rows.
    const fromExported = await loadTranscriptFile(out)
    const fromDb = store.loadTranscript(S)
    expect(normalize(fromExported)).toEqual(normalize(fromDb))
    // Metadata really came through the scan (not lost with the pre-boundary rows).
    expect([...fromExported.customTitles.values()]).toContain('Pre Title')
    expect(fromExported.messages.has(uid(100) as never)).toBe(false) // pre-boundary pruned
    expect(fromExported.messages.has(uid(200) as never)).toBe(true)
  })

  it('repairs a deleted canonical file and refreshes sync info', async () => {
    writeFixture([user(1, null, 'one'), user(2, uid(1), 'two')])
    await loadTranscriptCached(store, S, jsonl, 'proj')
    expect(store.getSyncInfo(S)).not.toBeNull()

    // Simulate the file being lost while rows survive.
    unlinkSync(jsonl)
    expect(existsSync(jsonl)).toBe(false)

    const result = exportSessionToFile(store, S)
    expect(result?.repairedCanonical).toBe(true)
    expect(existsSync(jsonl)).toBe(true)

    // Sync info refreshed → a cached read is immediately fresh.
    const fromCache = await loadTranscriptCached(store, S, jsonl, 'proj')
    expect(fromCache.messages.size).toBe(2)
    expect(store.getSyncInfo(S)).not.toBeNull()
  })

  it('export to an alternate path leaves canonical state untouched', async () => {
    writeFixture([user(1, null, 'one')])
    await loadTranscriptCached(store, S, jsonl, 'proj')
    const syncBefore = store.getSyncInfo(S)

    const out = join(dir, 'backup.jsonl')
    const result = exportSessionToFile(store, S, out)
    expect(result?.repairedCanonical).toBe(false)
    expect(store.getSyncInfo(S)).toEqual(syncBefore)
    expect(existsSync(out)).toBe(true)
  })

  it('returns null for unknown or empty sessions', () => {
    expect(exportSessionToFile(store, 'no-such-session')).toBeNull()
  })
})
