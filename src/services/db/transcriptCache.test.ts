/**
 * Read-through transcript cache tests.
 *
 * Verifies loadTranscriptCached serves the same shape loadTranscriptFile does
 * (all 20 fields), syncs on first read, takes the fresh fast-path when the
 * file is unchanged, and re-syncs (picking up appended entries) when the JSONL
 * grows or is rewritten. Also verifies freshness is path-aware: the same
 * size/mtime seen through a genuinely different file must not be trusted,
 * while a symlink alias of the same file must not force a pointless re-sync.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
  statSync,
  symlinkSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
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

/** Normalize a shape so Map/Set deep-compare cleanly via toEqual. Full-field. */
function normalize(shape: TranscriptShape): Record<string, unknown> {
  const m = <T>(map: Map<string, T>): Record<string, T> => Object.fromEntries(map)
  return {
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
    const fromCache = await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(normalize(fromCache)).toEqual(normalize(fromFile))
    const st = statSync(jsonl)
    expect(store.getSyncInfo(S)).toEqual({
      size: st.size,
      mtime: Math.trunc(st.mtimeMs),
      path: realpathSync(jsonl),
    })
  })

  it('second load with no change takes the fresh fast-path (same result)', async () => {
    await loadTranscriptCached(store, S, jsonl, PROJECT)
    const syncAfterFirst = store.getSyncInfo(S)
    expect(syncAfterFirst).not.toBeNull()

    // Unchanged file → still fresh, still correct, sync bookkeeping untouched.
    const fromFile = await loadTranscriptFile(jsonl)
    const fromCache = await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(store.getSyncInfo(S)).toEqual(syncAfterFirst)
    expect(normalize(fromCache)).toEqual(normalize(fromFile))
  })

  it('re-syncs after the JSONL grows, picking up appended entries', async () => {
    await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(store.loadTranscript(S).messages.size).toBe(2)

    appendFileSync(jsonl, JSON.stringify(user(2, 'third')) + '\n')
    // Bump mtime forward explicitly so staleness is unambiguous.
    const st = statSync(jsonl)
    utimesSync(jsonl, st.atime, new Date(st.mtimeMs + 2000))

    const fromFile = await loadTranscriptFile(jsonl)
    const fromCache = await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(fromCache.messages.size).toBe(3)
    expect(normalize(fromCache)).toEqual(normalize(fromFile))
  })

  it('re-syncs on compaction (file rewritten shorter)', async () => {
    await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(store.loadTranscript(S).messages.size).toBe(2)

    // Rewrite to a single message (simulates compaction).
    writeFileSync(jsonl, JSON.stringify(user(0, 'only')) + '\n')
    const st = statSync(jsonl)
    utimesSync(jsonl, st.atime, new Date(st.mtimeMs + 2000))

    const fromFile = await loadTranscriptFile(jsonl)
    const fromCache = await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(fromCache.messages.size).toBe(1)
    expect(normalize(fromCache)).toEqual(normalize(fromFile))
  })

  it('a symlink alias of the same file does not force a re-sync', async () => {
    await loadTranscriptCached(store, S, jsonl, PROJECT)
    const syncAfterFirst = store.getSyncInfo(S)

    const link = join(dir, 'link.jsonl')
    symlinkSync(jsonl, link)
    const fromCache = await loadTranscriptCached(store, S, link, PROJECT)

    // realpath canonicalization: same source through another path string.
    expect(store.getSyncInfo(S)).toEqual(syncAfterFirst)
    expect(normalize(fromCache)).toEqual(normalize(await loadTranscriptFile(jsonl)))
  })

  it('re-syncs when the same size/mtime is seen through a genuinely different file', async () => {
    await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(store.loadTranscript(S).messages.size).toBe(2)

    // A DIFFERENT file with byte-identical size and mtime: size+mtime alone
    // would wrongly serve the first file's rows for this one.
    const otherDir = join(dir, 'other-project')
    mkdirSync(otherDir)
    const other = join(otherDir, `${S}.jsonl`)
    // Contents differ but total byte length is identical to the original
    // ('hi'+'hello' = 7 = 'XXXXX'+'YY'), so size alone cannot distinguish.
    writeFileSync(
      other,
      [user(0, 'XXXXX'), user(1, 'YY')].map(e => JSON.stringify(e)).join('\n') + '\n',
    )
    const orig = statSync(jsonl)
    expect(statSync(other).size).toBe(orig.size)
    utimesSync(other, orig.atime, new Date(orig.mtimeMs))

    const fromCache = await loadTranscriptCached(store, S, other, PROJECT)
    expect(normalize(fromCache)).toEqual(normalize(await loadTranscriptFile(other)))
    expect(store.getSyncInfo(S)?.path).toBe(realpathSync(other))
  })

  it('self-heals when the session is marked fresh but its rows were deleted', async () => {
    await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(store.loadTranscript(S).messages.size).toBe(2)

    // Corrupt externally: wipe the rows, then re-mark as fresh with the
    // current stat — a naive loader would serve an empty transcript here.
    store.syncSession(S, PROJECT, [])
    const st = statSync(jsonl)
    store.setSyncInfo(S, st.size, Math.trunc(st.mtimeMs), realpathSync(jsonl))
    expect(store.loadTranscript(S).messages.size).toBe(0)

    const fromCache = await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(fromCache.messages.size).toBe(2)
    expect(normalize(fromCache)).toEqual(normalize(await loadTranscriptFile(jsonl)))
  })
})
