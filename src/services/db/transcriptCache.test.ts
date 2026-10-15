/**
 * Read-through transcript cache tests.
 *
 * Verifies loadTranscriptCached serves the same shape loadTranscriptFile does,
 * syncs on first read, takes the fresh fast-path when the file is unchanged,
 * and re-syncs (picking up appended entries) when the JSONL grows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTranscriptFile, type TranscriptShape } from '../../utils/sessionStorage.js'
import { SessionStore } from './SessionStore.js'
import { loadTranscriptCached } from './transcriptCache.js'
import type { Entry } from '../../types/logs.js'

const S = '00000000-0000-4000-8000-000000000002'
const PROJECT = '/tmp/proj'

function user(i: number, content: string): Entry {
  return {
    type: 'user',
    sessionId: S,
    uuid: `u${i}`,
    parentUuid: i === 0 ? null : `u${i - 1}`,
    timestamp: `t${i}`,
    message: { role: 'user', content },
  } as unknown as Entry
}

function normalize(shape: TranscriptShape): Record<string, unknown> {
  const m = <T>(map: Map<string, T>): Record<string, T> => Object.fromEntries(map)
  return {
    messages: m(shape.messages),
    summaries: m(shape.summaries),
    leafUuids: [...shape.leafUuids].sort(),
    customTitles: m(shape.customTitles),
  }
}

describe('loadTranscriptCached (read-through)', () => {
  let dir: string
  let store: SessionStore
  let jsonl: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codev-cache-'))
    store = SessionStore.open(join(dir, 'store.db'))
    jsonl = join(dir, `${S}.jsonl`)
    writeFileSync(jsonl, [user(0, 'hi'), user(1, 'hello')].map(e => JSON.stringify(e)).join('\n') + '\n')
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('first load syncs and matches loadTranscriptFile', async () => {
    const fromFile = await loadTranscriptFile(jsonl)
    const fromCache = loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(normalize(fromCache)).toEqual(normalize(fromFile))
  })

  it('second load with no change takes the fresh fast-path (same result)', async () => {
    loadTranscriptCached(store, S, jsonl, PROJECT)
    const syncAfterFirst = store.getSyncInfo(S)
    expect(syncAfterFirst).not.toBeNull()

    // Unchanged file → still fresh, still correct.
    const fromFile = await loadTranscriptFile(jsonl)
    const fromCache = loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(store.getSyncInfo(S)).toEqual(syncAfterFirst)
    expect(normalize(fromCache)).toEqual(normalize(fromFile))
  })

  it('re-syncs after the JSONL grows, picking up appended entries', async () => {
    loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(store.loadTranscript(S).messages.size).toBe(2)

    appendFileSync(jsonl, JSON.stringify(user(2, 'third')) + '\n')
    // Bump mtime forward explicitly so staleness is unambiguous.
    const st = statSync(jsonl)
    utimesSync(jsonl, st.atime, new Date(st.mtimeMs + 2000))

    const fromFile = await loadTranscriptFile(jsonl)
    const fromCache = loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(fromCache.messages.size).toBe(3)
    expect(normalize(fromCache)).toEqual(normalize(fromFile))
  })

  it('re-syncs on compaction (file rewritten shorter)', async () => {
    loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(store.loadTranscript(S).messages.size).toBe(2)

    // Rewrite to a single message (simulates compaction).
    writeFileSync(jsonl, JSON.stringify(user(0, 'only')) + '\n')
    const st = statSync(jsonl)
    utimesSync(jsonl, st.atime, new Date(st.mtimeMs + 2000))

    const fromFile = await loadTranscriptFile(jsonl)
    const fromCache = loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(fromCache.messages.size).toBe(1)
    expect(normalize(fromCache)).toEqual(normalize(fromFile))
  })
})
