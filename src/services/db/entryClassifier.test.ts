/**
 * Entry classifier tests — verify every Entry variant routes to the right
 * SQLite home (messages vs sessions) with the right read semantics.
 */
import { describe, it, expect } from 'vitest'
import { classifyEntry, isTranscriptShaped } from './entryClassifier.js'
import type { Entry } from '../../types/logs.js'

const base = { sessionId: 'sess-1', timestamp: new Date().toISOString() }

describe('classifyEntry', () => {
  it('routes transcript messages to the messages table', () => {
    const msg = { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } } as unknown as Entry
    expect(classifyEntry(msg)).toEqual({ kind: 'message' })
    for (const t of ['assistant', 'attachment', 'system'] as const) {
      const e = { ...base, type: t, uuid: 'x', parentUuid: null } as unknown as Entry
      expect(classifyEntry(e).kind).toBe('message')
    }
  })

  it('routes snapshots to snapshot (keyed by messageId)', () => {
    for (const t of ['file-history-snapshot', 'attribution-snapshot', 'content-replacement'] as const) {
      const e = { ...base, type: t, messageId: 'm1' } as unknown as Entry
      expect(classifyEntry(e)).toEqual({ kind: 'snapshot' })
    }
  })

  it('distinguishes collapse-commit (ordered) from collapse-snapshot (last-wins)', () => {
    const commit = { ...base, type: 'marble-origami-commit' } as unknown as Entry
    const snap = { ...base, type: 'marble-origami-snapshot' } as unknown as Entry
    expect(classifyEntry(commit)).toEqual({ kind: 'collapse-commit' })
    expect(classifyEntry(snap)).toEqual({ kind: 'collapse-snapshot' })
  })

  it('routes summary to summary (keyed by leafUuid, not session-scoped)', () => {
    const e = { ...base, type: 'summary', leafUuid: 'leaf1', summary: 'text' } as unknown as Entry
    expect(classifyEntry(e)).toEqual({ kind: 'summary' })
  })

  it('routes every session-meta type to its field', () => {
    const cases: Array<[string, string]> = [
      ['custom-title', 'customTitle'],
      ['ai-title', 'aiTitle'],
      ['tag', 'tag'],
      ['agent-name', 'agentName'],
      ['agent-color', 'agentColor'],
      ['agent-setting', 'agentSetting'],
      ['mode', 'mode'],
      ['worktree-state', 'worktreeState'],
      ['pr-link', 'prLink'],
      ['goal-state', 'goal'],
      ['goal', 'goal'],
      ['last-prompt', 'lastPrompt'],
      ['task-summary', 'taskSummary'],
    ]
    for (const [type, field] of cases) {
      const e = { ...base, type } as unknown as Entry
      expect(classifyEntry(e)).toEqual({ kind: 'session-meta', field })
    }
  })

  it('routes non-transcript-shaped types to opaque', () => {
    for (const t of ['queue-operation', 'speculation-accept'] as const) {
      const e = { ...base, type: t } as unknown as Entry
      expect(classifyEntry(e)).toEqual({ kind: 'opaque' })
    }
  })

  it('defaults unknown/legacy types to opaque', () => {
    const e = { ...base, type: 'progress', uuid: 'p1', parentUuid: null } as unknown as Entry
    expect(classifyEntry(e)).toEqual({ kind: 'opaque' })
  })

  it('isTranscriptShaped excludes only opaque', () => {
    expect(isTranscriptShaped({ kind: 'message' })).toBe(true)
    expect(isTranscriptShaped({ kind: 'session-meta', field: 'tag' })).toBe(true)
    expect(isTranscriptShaped({ kind: 'opaque' })).toBe(false)
  })
})
