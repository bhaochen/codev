/**
 * Trajectory compaction.
 *
 * When the root history grows very large, replace the middle of the conversation with a
 * running summary or elide old tool payloads. Keeps the system message + a fresh "continue"
 * instruction.
 */

import type { ChatMsg, CompleteFn, Usage } from './adapter.js'
import { estimateMessageTokens } from './tokens.js'

/** Absolute working ceiling: windows at/below this value are never compacted. */
const COMPACTION_CEILING_TOKENS = 1_000_000

const SUMMARY_REQUEST =
  'Summarize your progress so far. Include: (1) which sub-tasks are done and which remain; ' +
  '(2) any concrete intermediate results — numbers, values, variable names — preserved exactly; ' +
  '(3) your next action. Be concise (1–3 paragraphs) but preserve all key results.'

export const DEFAULT_COMPACTIONS = 1

/** True if the history is at/over the compaction threshold — the ABSOLUTE ceiling. */
export function shouldCompact(history: ChatMsg[]): boolean {
  return estimateMessageTokens(history) >= COMPACTION_CEILING_TOKENS
}

/** Never elide an ANSWER FRAME — `answer['content'] = …` is the run's only durable output. */
const ANSWER_FRAME_RE = /answer\[\s*['"](?:content|ready)['"]\s*\]|answers\s*\.\s*update\s*\(/

const REF_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g
const PAYLOAD_TOKEN_CAP = 64
const REF_TOKEN_CAP = 512

function payloadSignature(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 400) + '#' + content.length
}

function payloadTokens(content: string, into: Set<string>): void {
  let n = 0
  REF_TOKEN_RE.lastIndex = 0
  for (let m = REF_TOKEN_RE.exec(content); m !== null; m = REF_TOKEN_RE.exec(content)) {
    into.add(m[0])
    if (++n >= PAYLOAD_TOKEN_CAP) return
  }
}

/**
 * Elide old tool/repl payload bodies, keep the head (system) and the working-set tail.
 * Runs BEFORE shouldCompact.
 */
export function elideOldToolPayloads(
  history: ChatMsg[],
  keepTurns = 2,
  toolChars = 1_500,
): ChatMsg[] {
  if (history.length === 0) return history

  let tailStart = 0
  let seen = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      seen++
      if (seen >= keepTurns) {
        tailStart = i
        break
      }
    }
  }
  if (tailStart === 0) return history

  const future = new Set<string>()
  const referenced = new Array<boolean>(history.length).fill(false)
  const ids = new Set<string>()
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'assistant') {
      if (future.size < REF_TOKEN_CAP) payloadTokens(m.content, future)
      continue
    }
    if (m.role !== 'user' || i >= tailStart || m.content.length <= toolChars) continue
    if (ANSWER_FRAME_RE.test(m.content)) continue
    ids.clear()
    payloadTokens(m.content.slice(0, 2_000), ids)
    for (const id of ids) {
      if (future.has(id)) {
        referenced[i] = true
        break
      }
    }
  }

  let changed = false
  const marker =
    '\n…[elided v5-G1 — your repl sandbox is INTACT: variables/answers persist; re-run or ' +
    'print(answers) in the next repl to re-derive this content]…'
  const dupMarker =
    '\n…[dup v5-G1 — byte-identical payload already in this history; sandbox INTACT: ' +
    'print(<expr>) to inspect it again]…'
  const signatures = new Set<string>()
  const out: ChatMsg[] = new Array<ChatMsg>(history.length)
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (i < tailStart && m.role === 'user' && m.content.length > toolChars) {
      if (ANSWER_FRAME_RE.test(m.content)) {
        out[i] = m
        continue
      }
      const sig = payloadSignature(m.content)
      if (signatures.has(sig)) {
        out[i] = { role: 'user', content: dupMarker.trimStart() }
        changed = true
        continue
      }
      signatures.add(sig)
      if (referenced[i]) {
        out[i] = m
        continue
      }
      const body = m.content.slice(0, Math.max(0, toolChars - marker.length))
      out[i] = { role: 'user', content: body + marker }
      changed = true
    } else {
      out[i] = m
    }
  }
  return changed ? out : history
}

/**
 * Summarize the trajectory with one cheap model call and return a compacted history:
 * [system, summary(assistant), continue(user)].
 */
export async function compactHistory(
  history: ChatMsg[],
  complete: CompleteFn,
  count = DEFAULT_COMPACTIONS,
): Promise<ChatMsg[]> {
  const { text: summary, usage } = await complete([...history, { role: 'user', content: SUMMARY_REQUEST }], undefined)
  void usage
  const system = history.find((m) => m.role === 'system')
  const head: ChatMsg[] = system ? [system] : []
  return [
    ...head,
    { role: 'assistant', content: summary },
    {
      role: 'user',
      content:
        `Your conversation has been compacted ${count} time(s). Continue from the summary above. ` +
        'Do NOT repeat completed work. Use SHOW_VARS() to see existing REPL variables.',
    },
  ]
}

export type { Usage }
