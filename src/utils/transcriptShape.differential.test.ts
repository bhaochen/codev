/**
 * Differential fidelity test for the extracted reducer.
 *
 * Feeds an identical ordered list of entries to BOTH:
 *   - the real `loadTranscriptFile` (written to a temp JSONL file), and
 *   - the extracted `buildTranscriptShape` (fed the same parsed entries),
 * and asserts the two produce deep-equal `TranscriptShape`s.
 *
 * This proves `buildTranscriptShape` is a faithful extraction of the semantic
 * core out of `loadTranscriptFile`, BEFORE `loadTranscriptFile` is rewired to
 * call it. If the extraction had transcribed any of the 20 branches, the
 * progressBridge, the leaf computation, or the metadata ordering incorrectly,
 * this test fails.
 *
 * Files are kept well under SKIP_PRECOMPACT_THRESHOLD (5 MB) so `loadTranscriptFile`
 * takes the plain readFile path (no boundary truncation / metadataLines), which
 * makes the comparison exact: both see the full ordered entry list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTranscriptFile, buildTranscriptShape, type TranscriptShape } from './sessionStorage.js'
import { parseJSONL } from './json.js'
import type { Entry } from '../types/logs.js'

const S = 'sess-diff-1'

/** Build a comprehensive entry list covering every reducer branch. */
function buildEntries(): Entry[] {
  return [
    // --- Transcript messages (parent chain) ---
    { type: 'user', sessionId: S, uuid: 'u1', parentUuid: null, timestamp: 't1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', sessionId: S, uuid: 'a1', parentUuid: 'u1', timestamp: 't2', message: { role: 'assistant', content: 'hello' } },
    // Legacy progress in the middle of the chain (exercises progressBridge).
    { type: 'progress', sessionId: S, uuid: 'p1', parentUuid: 'a1', timestamp: 't3' },
    { type: 'system', sessionId: S, uuid: 's1', parentUuid: 'p1', timestamp: 't4', message: { role: 'system', content: 'sys' } },
    { type: 'user', sessionId: S, uuid: 'u2', parentUuid: 's1', timestamp: 't5', message: { role: 'user', content: 'more' } },
    // --- Summary (keyed by leafUuid) ---
    { type: 'summary', sessionId: S, leafUuid: 'a1', summary: 'a summary' },
    // --- Session metadata (last-wins) ---
    { type: 'custom-title', sessionId: S, customTitle: 'My Title', timestamp: 't6' },
    { type: 'tag', sessionId: S, tag: 'backend', timestamp: 't7' },
    { type: 'agent-name', sessionId: S, agentName: 'Agent X', timestamp: 't8' },
    { type: 'agent-color', sessionId: S, agentColor: 'blue', timestamp: 't9' },
    { type: 'agent-setting', sessionId: S, agentSetting: '{"k":1}', timestamp: 't10' },
    { type: 'mode', sessionId: S, mode: 'code', timestamp: 't11' },
    { type: 'worktree-state', sessionId: S, worktreeSession: null, timestamp: 't12' },
    { type: 'pr-link', sessionId: S, prNumber: 123, prUrl: 'http://x/123', prRepository: 'repo', timestamp: 't13' },
    { type: 'goal-state', sessionId: S, timestamp: 't14', goals: [] },
    // --- Snapshots (keyed by messageId) ---
    { type: 'file-history-snapshot', messageId: 'm1', timestamp: 't15', commits: [] },
    { type: 'attribution-snapshot', messageId: 'm2', timestamp: 't16', attribution: {} },
    // --- Content replacement (session-keyed + agent-keyed) ---
    { type: 'content-replacement', sessionId: S, timestamp: 't17', replacements: [{ old: 'a', new: 'b' }] },
    { type: 'content-replacement', sessionId: S, agentId: 'agent-1', timestamp: 't18', replacements: [{ old: 'c', new: 'd' }] },
    // --- Context collapse (ordered commits + last-wins snapshot) ---
    { type: 'marble-origami-commit', sessionId: S, timestamp: 't19', removedUuids: ['u1'] },
    { type: 'marble-origami-commit', sessionId: S, timestamp: 't20', removedUuids: ['a1'] },
    { type: 'marble-origami-snapshot', sessionId: S, timestamp: 't21', snapshot: {} },
  ] as unknown as Entry[]
}

/** Second scenario: compact boundary resets collapse state mid-stream. */
function buildEntriesWithBoundary(): Entry[] {
  return [
    { type: 'user', sessionId: S, uuid: 'b1', parentUuid: null, timestamp: 't1', message: { role: 'user', content: 'pre' } },
    { type: 'marble-origami-commit', sessionId: S, timestamp: 't2', removedUuids: ['b1'] },
    // Compact boundary: should clear the collapse commits accumulated above.
    { type: 'system', sessionId: S, uuid: 'cb', parentUuid: 'b1', subtype: 'compact_boundary', timestamp: 't3', message: { role: 'system', content: 'boundary' } },
    { type: 'user', sessionId: S, uuid: 'b2', parentUuid: 'cb', timestamp: 't4', message: { role: 'user', content: 'post' } },
  ] as unknown as Entry[]
}

/** Normalize a shape so Map/Set deep-compare cleanly via toEqual. */
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

describe('buildTranscriptShape differential fidelity vs loadTranscriptFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codev-shape-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function runDifferential(entries: Entry[]): Promise<void> {
    const file = join(dir, 'transcript.jsonl')
    writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

    // Ground truth: the real JSONL path.
    const fromFile = await loadTranscriptFile(file)

    // The extracted reducer, fed the SAME parsed entries loadTranscriptFile sees.
    const parsed = parseJSONL<Entry>(readFileSync(file))
    const fromReducer = buildTranscriptShape(parsed)

    expect(normalize(fromReducer)).toEqual(normalize(fromFile))
  }

  it('matches loadTranscriptFile on a comprehensive entry set', async () => {
    await runDifferential(buildEntries())
  })

  it('matches loadTranscriptFile when a compact boundary resets collapse state', async () => {
    await runDifferential(buildEntriesWithBoundary())
  })

  it('matches loadTranscriptFile on an empty transcript', async () => {
    await runDifferential([])
  })

  it('matches loadTranscriptFile on a single user message', async () => {
    await runDifferential([
      { type: 'user', sessionId: S, uuid: 'only', parentUuid: null, timestamp: 't1', message: { role: 'user', content: 'x' } },
    ] as unknown as Entry[])
  })
})
