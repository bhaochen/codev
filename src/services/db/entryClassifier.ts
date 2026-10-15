/**
 * Entry classifier — routes a JSONL `Entry` to its SQLite home.
 *
 * This is the shared foundation for the SQLite-backed persistence layer: both
 * the write path (entry → rows) and the read path (rows → transcript shape)
 * consult this classifier, so the two can never disagree about where a piece
 * of data lives.
 *
 * The categories mirror exactly how `loadTranscriptFile` consumes each entry
 * type (src/utils/sessionStorage.ts:3577). An entry kind's routing encodes:
 *   - which table it lands in (messages vs sessions), and
 *   - the read semantics (order matters vs last-wins vs keyed by X).
 *
 * Fidelity note: `loadTranscriptFile` does NOT surface every written entry
 * type in its return shape (e.g. ai-title, last-prompt, task-summary, queue-op,
 * speculation-accept are written but read elsewhere or only via the lite
 * head/tail scan). Those route to `session-meta` (persisted for other readers)
 * or `opaque` (persisted but not part of the transcript shape) accordingly.
 */
import type { Entry } from '../../types/logs.js'

/** Session-scoped metadata fields stored as columns on the sessions row. */
export type SessionMetaField =
  | 'customTitle'
  | 'tag'
  | 'agentName'
  | 'agentColor'
  | 'agentSetting'
  | 'mode'
  | 'worktreeState'
  | 'prLink'
  | 'goal'
  | 'aiTitle'
  | 'lastPrompt'
  | 'taskSummary'

export type EntryRouting =
  /** Transcript message (user/assistant/attachment/system) → messages table. */
  | { kind: 'message' }
  /** Snapshot keyed by messageId → messages table. */
  | { kind: 'snapshot' }
  /** Context-collapse commit → messages table; ORDER MATTERS (array). */
  | { kind: 'collapse-commit' }
  /** Context-collapse snapshot → messages table; last-wins. */
  | { kind: 'collapse-snapshot' }
  /** Summary keyed by leafUuid (not session-scoped). */
  | { kind: 'summary' }
  /** Session metadata → sessions row column; last-wins. */
  | { kind: 'session-meta'; field: SessionMetaField }
  /** Written but not part of loadTranscriptFile's return shape. */
  | { kind: 'opaque' }

const SESSION_META_BY_TYPE: Record<string, SessionMetaField> = {
  'custom-title': 'customTitle',
  'ai-title': 'aiTitle',
  tag: 'tag',
  'agent-name': 'agentName',
  'agent-color': 'agentColor',
  'agent-setting': 'agentSetting',
  mode: 'mode',
  'worktree-state': 'worktreeState',
  'pr-link': 'prLink',
  'goal-state': 'goal',
  goal: 'goal',
  'last-prompt': 'lastPrompt',
  'task-summary': 'taskSummary',
}

/**
 * Route an entry. Pure and total — every Entry variant has a routing.
 */
export function classifyEntry(entry: Entry): EntryRouting {
  switch (entry.type) {
    // Transcript messages → messages table.
    case 'user':
    case 'assistant':
    case 'attachment':
    case 'system':
      return { kind: 'message' }

    // Snapshots keyed by messageId.
    case 'file-history-snapshot':
    case 'attribution-snapshot':
    case 'content-replacement':
      return { kind: 'snapshot' }

    // Context collapse — commit order matters; snapshot is last-wins.
    case 'marble-origami-commit':
      return { kind: 'collapse-commit' }
    case 'marble-origami-snapshot':
      return { kind: 'collapse-snapshot' }

    // Summary is keyed by leafUuid, not session-scoped.
    case 'summary':
      return { kind: 'summary' }

    // Session-scoped metadata → sessions columns (last-wins).
    case 'custom-title':
    case 'ai-title':
    case 'tag':
    case 'agent-name':
    case 'agent-color':
    case 'agent-setting':
    case 'mode':
    case 'worktree-state':
    case 'pr-link':
    case 'goal-state':
    case 'goal':
    case 'last-prompt':
    case 'task-summary':
      return { kind: 'session-meta', field: SESSION_META_BY_TYPE[entry.type] }

    // Written but not surfaced by loadTranscriptFile's return shape.
    case 'queue-operation':
    case 'speculation-accept':
      return { kind: 'opaque' }

    default: {
      // Unknown/legacy types (e.g. progress) are persisted but not shaped.
      return { kind: 'opaque' }
    }
  }
}

/** True if this entry is consumed by loadTranscriptFile's return shape. */
export function isTranscriptShaped(routing: EntryRouting): boolean {
  return routing.kind !== 'opaque'
}
