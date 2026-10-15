/**
 * Large-file read-through cache fidelity (files > SKIP_PRECOMPACT_THRESHOLD).
 *
 * Files over 5MB take a fundamentally different read path than small ones:
 *   - fd-level attribution-snapshot skipping (only the last snap survives,
 *     re-appended at EOF),
 *   - compact-boundary truncation (bytes before the last non-preserved
 *     boundary never enter the buffer),
 *   - pre-boundary session-scoped metadata recovery (byte scan of [0, offset)),
 *   - walkChainBeforeParse pruning of dead fork branches when dead bytes
 *     ≥ 50% of the post-boundary buffer.
 *
 * A cache that synced from a naive full-file read would diverge from
 * loadTranscriptFile here (pre-boundary messages and dead branches leaking
 * into the shape, stale attr-snaps kept). The cache parses through the SAME
 * pipeline (parseTranscriptFile), so this test pins the property: for the
 * same file bytes, loadTranscriptCached ≡ loadTranscriptFile — and the
 * realism assertions prove each optimization actually engaged (if a fixture
 * silently misses a gate, the test fails instead of comparing two naive
 * reads).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTranscriptFile, type TranscriptShape } from '../../utils/sessionStorage.js'
import { SessionStore } from './SessionStore.js'
import { loadTranscriptCached } from './transcriptCache.js'
import type { Entry } from '../../types/logs.js'

const S = '00000000-0000-4000-8000-000000000003'
const PROJECT = '/tmp/proj'
const MB = 1024 * 1024

/** Exactly-36-char UUIDs — walkChainBeforeParse reads fixed 36-byte slices. */
function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function pad(n: number): string {
  return 'x'.repeat(n)
}

/**
 * Transcript message mirroring insertMessageChain's serialization order:
 * parentUuid first (what walkChainBeforeParse's `{"parentUuid":` prefix
 * matcher requires), uuid immediately followed by timestamp (the suffix
 * check that keeps content-embedded uuids from poisoning the index).
 */
function msg(
  n: number,
  parent: string | null,
  content: string,
  opts?: { sidechain?: boolean; type?: 'user' | 'assistant' },
): Entry {
  const type = opts?.type ?? 'user'
  return {
    parentUuid: parent,
    isSidechain: opts?.sidechain ?? false,
    uuid: uid(n),
    timestamp: new Date(1700000000000 + n).toISOString(),
    type,
    sessionId: S,
    message: { role: type, content },
  } as unknown as Entry
}

/**
 * Compact boundary in production serialization: starts `{"type":"system"`
 * so the marker sits ~28 bytes in (scanChunkLines' 256-byte search bound)
 * AND the chunk-seam straddle path (SYSTEM_PREFIX match) detects it too.
 */
function boundary(
  n: number,
  compactMetadata: Record<string, unknown>,
): Entry {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date(1700000000000 + n).toISOString(),
    uuid: uid(n),
    level: 'info',
    compactMetadata,
  } as unknown as Entry
}

/** Session-scoped metadata entries: type first so the marker byte scan finds
 *  `"type":"..."` at line offset 1 (within METADATA_PREFIX_BOUND). */
function meta(type: string, fields: Record<string, unknown>): Entry {
  return {
    type,
    sessionId: S,
    timestamp: new Date(1700000000000).toISOString(),
    ...fields,
  } as unknown as Entry
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

describe('loadTranscriptCached on large (>5MB) compacted transcripts', () => {
  let dir: string
  let store: SessionStore
  let jsonl: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codev-cache-large-'))
    store = SessionStore.open(join(dir, 'store.db'))
    jsonl = join(dir, `${S}.jsonl`)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Layout (both tests follow this pattern):
   *   sync first load → compare vs ground truth → second (fresh, no-parse)
   *   load → compare again, proving the STORED rows replay the reader's
   *   view rather than a full-file read.
   */
  async function expectBothLoadsMatchGroundTruth(): Promise<Record<string, unknown>> {
    const fromFile = await loadTranscriptFile(jsonl)

    const firstLoad = await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(normalize(firstLoad)).toEqual(normalize(fromFile))
    expect(store.getSyncInfo(S)).not.toBeNull()

    // Fresh fast-path: serves stored rows with no JSONL parse at all.
    const freshLoad = await loadTranscriptCached(store, S, jsonl, PROJECT)
    expect(normalize(freshLoad)).toEqual(normalize(fromFile))

    return normalize(fromFile)
  }

  it('boundary truncation + metadata recovery + walkChain pruning are all reproduced', async () => {
    // --- Pre-boundary region (~5.6MB) — must be truncated by the reader,
    // except marker-matched session metadata recovered by the byte scan.
    const pre: Entry[] = []
    for (let i = 0; i < 8; i++) {
      pre.push(msg(1000 + i, i === 0 ? null : uid(999 + i), pad(700 * 1024), {
        type: i % 2 === 0 ? 'user' : 'assistant',
      }))
    }
    pre.push(meta('custom-title', { customTitle: 'Pre-boundary title' }))
    pre.push(meta('tag', { tag: 'release' }))
    pre.push(meta('mode', { mode: 'normal' }))
    pre.push(meta('summary', { summary: 'pre-compact summary', leafUuid: uid(1003) }))
    // Not marker-matched: dropped wholesale by truncation on large files.
    pre.push({ type: 'file-history-snapshot', messageId: 'pre-fh-1', timestamp: new Date().toISOString(), commits: [] } as unknown as Entry)
    pre.push({ type: 'attribution-snapshot', messageId: 'pre-at-1', timestamp: new Date().toISOString(), attribution: {} } as unknown as Entry)

    // --- Boundary (non-preserved): truncates everything above.
    const b1 = boundary(9000, { trigger: 'auto', preTokens: 190000, messagesSummarized: 42 })

    // --- Post-boundary live chain (~1.5MB).
    const live: Entry[] = []
    for (let i = 0; i < 5; i++) {
      live.push(msg(2000 + i, i === 0 ? uid(9000) : uid(1999 + i), pad(300 * 1024), {
        type: i % 2 === 0 ? 'user' : 'assistant',
      }))
    }
    const postMeta: Entry[] = [
      meta('custom-title', { customTitle: 'Post title' }),
      { type: 'file-history-snapshot', messageId: 'post-fh-1', timestamp: new Date().toISOString(), commits: [] } as unknown as Entry,
      { type: 'attribution-snapshot', messageId: 'post-at-1', timestamp: new Date().toISOString(), attribution: {} } as unknown as Entry,
    ]

    // --- Dead sidechain branch (~3.6MB) rooted in the live chain: unreachable
    // from the leaf walking parentUuids, ≥50% of post-boundary bytes → pruned.
    const dead: Entry[] = []
    for (let i = 0; i < 12; i++) {
      dead.push(
        msg(3000 + i, i === 0 ? uid(2004) : uid(2999 + i), pad(300 * 1024), {
          sidechain: true,
          type: i % 2 === 0 ? 'assistant' : 'user',
        }),
      )
    }

    // --- Live tail AFTER the dead branch — the walk's leaf lives here.
    const tail: Entry[] = []
    for (let i = 0; i < 3; i++) {
      tail.push(msg(4000 + i, i === 0 ? uid(2004) : uid(3999 + i), pad(250 * 1024), {
        type: i % 2 === 0 ? 'user' : 'assistant',
      }))
    }

    const entries = [...pre, b1, ...live, ...postMeta, ...dead, ...tail]
    writeFileSync(jsonl, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

    // Fixture realism: gates must actually engage (else this compares two
    // naive full reads and proves nothing).
    const fileBytes = entries.reduce(
      (n, e) => n + JSON.stringify(e).length + 1,
      0,
    )
    expect(fileBytes).toBeGreaterThan(10 * MB)
    const postBoundaryBytes = [...live, ...postMeta, ...dead, ...tail].reduce(
      (n, e) => n + JSON.stringify(e).length + 1,
      0,
    )
    expect(postBoundaryBytes).toBeGreaterThan(5 * MB)
    expect(dead.reduce((n, e) => n + JSON.stringify(e).length + 1, 0)).toBeGreaterThan(
      postBoundaryBytes / 2,
    )

    const nf = await expectBothLoadsMatchGroundTruth()

    const messages = nf.messages as Record<string, { parentUuid?: string | null }>
    // Reader truncation engaged: pre-boundary messages absent.
    expect(messages).not.toHaveProperty(uid(1000))
    expect(messages).not.toHaveProperty(uid(1007))
    // walkChain pruning engaged: dead sidechain absent, live chain intact.
    expect(messages).not.toHaveProperty(uid(3000))
    expect(messages).not.toHaveProperty(uid(3011))
    expect(messages).toHaveProperty(uid(2000)) // first live post-boundary
    expect(messages).toHaveProperty(uid(4002)) // leaf
    // Pre-boundary metadata recovered, then overwritten by the post-boundary
    // value in the main pass — proving BOTH passes ran in the right order.
    expect(Object.values(nf.customTitles)).toEqual(['Post title'])
    expect(Object.values(nf.tags)).toEqual(['release'])
    expect(Object.values(nf.summaries)).toEqual(['pre-compact summary'])
    // Marker-less snapshots are NOT recovered pre-boundary, ARE kept after.
    const fh = nf.fileHistorySnapshots as Record<string, unknown>
    expect(fh).not.toHaveProperty('pre-fh-1')
    expect(fh).toHaveProperty('post-fh-1')
    const at = nf.attributionSnapshots as Record<string, unknown>
    expect(at).not.toHaveProperty('pre-at-1')
    expect(at).toHaveProperty('post-at-1')
  })

  it('preservedSegment boundary: no truncation at the seg, prune at it, relink applied', async () => {
    // --- Region A (~2MB) before the first boundary: reader-truncated.
    const regionA: Entry[] = []
    for (let i = 0; i < 4; i++) {
      regionA.push(msg(1000 + i, i === 0 ? null : uid(999 + i), pad(500 * 1024), {
        type: i % 2 === 0 ? 'user' : 'assistant',
      }))
    }
    regionA.push(meta('custom-title', { customTitle: 'Seg pre title' }))

    const b1 = boundary(9001, { trigger: 'auto', preTokens: 120000 })

    // --- Region B: dead (non-preserved) chain + the preserved segment.
    const regionB: Entry[] = []
    for (let i = 0; i < 4; i++) {
      regionB.push(msg(5000 + i, i === 0 ? uid(9001) : uid(4999 + i), pad(250 * 1024), {
        type: i % 2 === 0 ? 'user' : 'assistant',
      }))
    }
    // Preserved segment: head ps0 … tail ps3, physically pre-b2, original
    // pre-compact parentUuids (recordTranscript dedup-skipped them).
    regionB.push(msg(6000, uid(5002), pad(50 * 1024)))
    regionB.push(msg(6001, uid(6000), pad(50 * 1024), { type: 'assistant' }))
    regionB.push(msg(6002, uid(6001), pad(50 * 1024)))
    regionB.push(msg(6003, uid(6002), pad(50 * 1024)))

    // --- b2: preservedSegment boundary — must NOT truncate at itself.
    const b2 = boundary(9002, {
      trigger: 'auto',
      preTokens: 150000,
      preservedSegment: {
        headUuid: uid(6000),
        anchorUuid: uid(9002),
        tailUuid: uid(6003),
      },
    })

    // --- Region C tail (~1.95MB): chains onto b2, relinked onto the tail.
    const regionC: Entry[] = []
    for (let i = 0; i < 3; i++) {
      regionC.push(msg(7000 + i, i === 0 ? uid(9002) : uid(6999 + i), pad(650 * 1024), {
        type: i % 2 === 0 ? 'user' : 'assistant',
      }))
    }

    const entries = [...regionA, b1, ...regionB, b2, ...regionC]
    writeFileSync(jsonl, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

    const fileBytes = entries.reduce((n, e) => n + JSON.stringify(e).length + 1, 0)
    expect(fileBytes).toBeGreaterThan(5 * MB) // gated reader regime

    const nf = await expectBothLoadsMatchGroundTruth()

    const messages = nf.messages as Record<string, { parentUuid?: string | null }>
    // Reader truncation at b1 (earlier non-preserved boundary): A gone.
    expect(messages).not.toHaveProperty(uid(1000))
    // Reducer prune at b2: dead non-preserved B chain gone.
    expect(messages).not.toHaveProperty(uid(5000))
    expect(messages).not.toHaveProperty(uid(5003))
    // Preserved segment survives (this is the whole point of seg boundaries).
    expect(messages).toHaveProperty(uid(6000))
    expect(messages).toHaveProperty(uid(6003))
    expect(messages).toHaveProperty(uid(7000)) // tail region
    // Relink actually ran: head reparented to the anchor (b2), region C's
    // first message spliced from the anchor onto the segment tail.
    expect(messages[uid(6000)]?.parentUuid).toBe(uid(9002))
    expect(messages[uid(7000)]?.parentUuid).toBe(uid(6003))
    // Pre-b1 metadata recovered through the byte scan.
    expect(Object.values(nf.customTitles)).toEqual(['Seg pre title'])
  })
})
