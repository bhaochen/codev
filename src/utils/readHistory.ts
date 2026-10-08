/**
 * Which agents have read each file this session.
 *
 * The read-state caches that gate Edit, Write and NotebookEdit forget reads:
 * compaction and /clear empty them, the LRU drops the oldest entries once it
 * is full, and a fresh subagent starts with an empty one. A model that
 * remembers reading a file is then told it "has not been read yet", which
 * contradicts what it saw and invites arguing or workarounds instead of a new
 * Read. This record only lets the refusal say which case applies. It never
 * satisfies the gate: an edit still needs a read the current cache holds.
 */

import { normalize } from 'path'

const MAIN_THREAD = 'main'
const MAX_TRACKED_PATHS = 2000

const readers = new Map<string, Set<string>>()

/** Record a Read of `filePath` by the main thread or a subagent. */
export function recordFileRead(
  filePath: string,
  agentId: string | undefined,
): void {
  const key = normalize(filePath)
  const agents = readers.get(key) ?? new Set<string>()
  agents.add(agentId ?? MAIN_THREAD)
  // Re-insert so the size bound drops the least recently read path first.
  readers.delete(key)
  readers.set(key, agents)
  if (readers.size > MAX_TRACKED_PATHS) {
    const oldest = readers.keys().next().value
    if (oldest !== undefined) readers.delete(oldest)
  }
}

/** A new conversation (/clear) has read nothing yet. */
export function resetReadHistory(): void {
  readers.clear()
}

export function _resetReadHistoryForTest(): void {
  readers.clear()
}

const NEVER_READ = 'File has not been read yet.'
const READ_EARLIER =
  'You read this file earlier, but that read is no longer on record (the conversation was compacted, or older reads were dropped to save memory).'
const READ_BY_OTHER_AGENT =
  'This file was read by another agent, not in this conversation.'
const PARTIAL_VIEW_BASE =
  'Only part of this file has been read (a skeleton, or content injected with parts removed)'
const PARTIAL_VIEW = `${PARTIAL_VIEW_BASE}.`

/**
 * The refusal for changing a file that has no current read.
 *
 * `neverRead` finishes the message when nobody read the file this session,
 * and stays each tool's long-standing wording. `action` ("before editing it")
 * and the optional `after` step finish the other cases.
 */
export function unreadFileRefusal(
  filePath: string,
  agentId: string | undefined,
  advice: { neverRead: string; action: string; after?: string },
): string {
  const then = advice.after ? `, then ${advice.after}` : ''
  const agents = readers.get(normalize(filePath))
  if (!agents) return `${NEVER_READ} ${advice.neverRead}`
  if (agents.has(agentId ?? MAIN_THREAD)) {
    return `${READ_EARLIER} Read it again with the Read tool ${advice.action}${then}. It may have changed since.`
  }
  return `${READ_BY_OTHER_AGENT} Read it yourself with the Read tool ${advice.action}${then}.`
}

/** The refusal for replacing a file the model has only seen part of. */
export function partialViewRefusal(action: string): string {
  return `${PARTIAL_VIEW} Read it in full with the Read tool ${action}.`
}

/**
 * True for every refusal above, so the UI can show them as routine. Matches
 * only the start: a refusal may show file content that repeats these words.
 */
export function isUnreadFileRefusal(message: string): boolean {
  const text = message.trimStart()
  return [
    'File has not been read yet',
    'You read this file earlier',
    'This file was read by another agent',
    PARTIAL_VIEW_BASE,
  ].some(prefix => text.startsWith(prefix))
}
