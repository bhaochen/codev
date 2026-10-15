/**
 * SQLite transcript round-trip fidelity test.
 *
 * Proves the SQLite-backed store reconstructs the EXACT transcript shape the
 * JSONL path produces:
 *   - JSONL: write entries to a temp .jsonl → loadTranscriptFile → shape A
 *   - SQLite: writeTranscript(entries) → loadTranscript() → shape B
 *   - assert deep-equal(A, B)
 *
 * The reducer itself is proven faithful by transcriptShape.differential.test.ts;
 * THIS test proves the STORAGE layer (write → seq-ordered read → data_json
 * parse) preserves entries with full fidelity — order, all entry types, and
 * metadata entries that lack a uuid.
 *
 * Entries are kept small (well under SKIP_PRECOMPACT_THRESHOLD) so the JSONL
 * path takes the plain readFile path (no boundary truncation), which the
 * SQLite store matches by reading all rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTranscriptFile, type TranscriptShape } from '../../utils/sessionStorage.js'
import { SessionStore } from './SessionStore.js'
import type { Entry } from '../../types/logs.js'

const S = 'sess-rt-1'
const PROJECT = '/tmp/proj'

/** Comprehensive entry set covering every reducer + storage branch. */
function buildEntries(): Entry[] {
  return [
    { type: 'user', sessionId: S, uuid: 'u1', parentUuid: null, timestamp: 't1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', sessionId: S, uuid: 'a1', parentUuid: 'u1', timestamp: 't2', message: { role: 'assistant', content: 'hello' } },
    { type: 'progress', sessionId: S, uuid: 'p1', parentUuid: 'a1', timestamp: 't3' },
    { type: 'system', sessionId: S, uuid: 's1', parentUuid: 'p1', timestamp: 't4', message: { role: 'system', content: 'sys' } },
    { type: 'user', sessionId: S, uuid: 'u2', parentUuid: 's1', timestamp: 't5', message: { role: 'user', content: 'more' } },
    { type: 'summary', sessionId: S, leafUuid: 'a1', summary: 'a summary' },
    { type: 'custom-title', sessionId: S, customTitle: 'My Title', timestamp: 't6' },
    { type: 'tag', sessionId: S, tag: 'backend', timestamp: 't7' },
    { type: 'agent-name', sessionId: S, agentName: 'Agent X', timestamp: 't8' },
    { type: 'agent-color', sessionId: S, agentColor: 'blue', timestamp: 't9' },
    { type: 'agent-setting', sessionId: S, agentSetting: '{"k":1}', timestamp: 't10' },
    { type: 'mode', sessionId: S, mode: 'code', timestamp: 't11' },
    { type: 'worktree-state', sessionId: S, worktreeSession: null, timestamp: 't12' },
    { type: 'pr-link', sessionId: S, prNumber: 123, prUrl: 'http://x/123', prRepository: 'repo', timestamp: 't13' },
    { type: 'goal-state', sessionId: S, timestamp: 't14', goals: [] },
    { type: 'file-history-snapshot', messageId: 'm1', timestamp: 't15', commits: [] },
    { type: 'attribution-snapshot', messageId: 'm2', timestamp: 't16', attribution: {} },
    { type: 'content-replacement', sessionId: S, timestamp: 't17', replacements: [{ old: 'a', new: 'b' }] },
    { type: 'content-replacement', sessionId: S, agentId: 'agent-1', timestamp: 't18', replacements: [{ old: 'c', new: 'd' }] },
    { type: 'marble-origami-commit', sessionId: S, timestamp: 't19', removedUuids: ['u1'] },
    { type: 'marble-origami-commit', sessionId: S, timestamp: 't20', removedUuids: ['a1'] },
    { type: 'marble-origami-snapshot', sessionId: S, timestamp: 't21', snapshot: {} },
  ] as unknown as Entry[]
}

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

describe('SQLite transcript round-trip fidelity vs loadTranscriptFile', () => {
  let dir: string
  let store: SessionStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codev-rt-'))
    store = SessionStore.open(join(dir, 'store.db'))
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writeTranscript → loadTranscript matches loadTranscriptFile', async () => {
    const entries = buildEntries()

    // JSONL ground truth.
    const jsonl = join(dir, 'transcript.jsonl')
    writeFileSync(jsonl, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
    const fromFile = await loadTranscriptFile(jsonl)

    // SQLite round-trip.
    store.writeTranscript(S, PROJECT, entries)
    const fromDb = store.loadTranscript(S)

    expect(normalize(fromDb)).toEqual(normalize(fromFile))
  })

  it('preserves append order across multiple write calls', async () => {
    const batch1 = buildEntries().slice(0, 5)
    const batch2 = buildEntries().slice(5)

    const all = [...batch1, ...batch2]
    const jsonl = join(dir, 'transcript.jsonl')
    writeFileSync(jsonl, all.map(e => JSON.stringify(e)).join('\n') + '\n')
    const fromFile = await loadTranscriptFile(jsonl)

    store.writeTranscript(S, PROJECT, batch1)
    store.writeTranscript(S, PROJECT, batch2)
    const fromDb = store.loadTranscript(S)

    expect(normalize(fromDb)).toEqual(normalize(fromFile))
  })

  it('round-trips an empty transcript', async () => {
    const jsonl = join(dir, 'transcript.jsonl')
    writeFileSync(jsonl, '')
    const fromFile = await loadTranscriptFile(jsonl)

    // No writeTranscript call — session has no rows.
    const fromDb = store.loadTranscript(S)

    expect(normalize(fromDb)).toEqual(normalize(fromFile))
    expect(fromDb.messages.size).toBe(0)
  })
})
