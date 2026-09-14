/**
 * Helpers for detecting and formatting the RLM final answer from a turn's REPL results.
 *
 * Ported from rlm.pi/pi-plugin/rlm/src/core/answer.ts + src/text/repl-output.ts.
 */

import type { ReplResult } from './protocol.js'
import { truncateOutput } from './parsing.js'

/** Max stderr kept in model-visible REPL output. */
const STDERR_LIMIT = 8_000

/** Prefix stderr so the model can tell prints from exceptions. Empty when stderr is blank. */
export function formatReplStderr(stderr: string, limit = STDERR_LIMIT): string {
  const err = stderr.trim()
  return err ? `\n[stderr]\n${truncateOutput(err, limit)}` : ''
}

/** First non-blank final answer across a turn's executed blocks, or null. A blank capture counts
 *  as absent: an empty `answer.ready` flip must never terminate a run with "". */
export function finalAnswerOf(results: readonly ReplResult[]): string | null {
  for (const r of results) {
    if (r.finalAnswer != null && r.finalAnswer.trim() !== '') return r.finalAnswer
  }
  return null
}

/** Last non-empty answer content set by the REPL, even if answer.ready was not flipped. */
export function latestAnswerContentOf(results: readonly ReplResult[]): string | null {
  for (let i = results.length - 1; i >= 0; i--) {
    const content = results[i]?.answerContent.trim()
    if (content) return content
  }
  return null
}

/** Cap for the recovered-stdout fallback — it rides `RlmResult`, not history. */
const LAST_STDOUT_CAP = 4_000

/** Last non-empty stdout across a turn's blocks, capped. A run that ends without an
 *  `answer[...]` frame still printed its winning value, and re-running the whole task to get it
 *  is a waste (and non-deterministic). */
export function latestStdoutOf(results: readonly ReplResult[]): string {
  for (let i = results.length - 1; i >= 0; i--) {
    const out = results[i]?.stdout.trim()
    if (out) return out.length > LAST_STDOUT_CAP ? out.slice(-LAST_STDOUT_CAP) : out
  }
  return ''
}

/** True if any block in the turn raised an exception. Plain stderr does not count. */
export function turnHadError(results: readonly ReplResult[]): boolean {
  return results.some((r) => r.raised)
}

/** Max stdout kept verbatim in history. Larger outputs collapse to a small preview + elision note —
 *  the full content persists in REPL variables, never in the root model's history. */
const SMALL_STDOUT_LIMIT = 800
const STDOUT_PREVIEW_LIMIT = 200
const STDOUT_TAIL_LIMIT = 200

/** The REPL output fed back to the model as the next user message. Prefixed `REPL stdout:`. */
export function formatReplOutputs(results: readonly ReplResult[], skippedBlocks = 0): string {
  if (results.length === 0) {
    return 'No ```repl``` block found in your response. Write one to interact with the REPL.'
  }
  const multi = results.length > 1
  const parts = new Array<string>(results.length)
  let hadElision = false
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const head = multi ? `[block ${i + 1}]\n` : ''
    const { text, elided } = formatStdout(r)
    hadElision ||= elided
    parts[i] = `${head}${text}${formatReplStderr(r.stderr)}`
  }
  const body = parts.join('\n\n')
  const skipNote =
    skippedBlocks > 0
      ? `\n\n[${skippedBlocks} later \`\`\`repl\`\`\` block(s) skipped because an earlier block raised — fix and re-run them]`
      : ''
  // Orientation hint only when the model lost output to elision — otherwise it sees everything.
  if (!hadElision) return `REPL stdout:\n${body}${skipNote}`
  // The REPL namespace is persistent across blocks in a turn, so the last block's varNames reflect
  // every variable created in any earlier block too.
  const varNames = results.at(-1)?.varNames ?? []
  const hint =
    varNames.length > 0
      ? `REPL vars: ${varNames.join(', ')}`
      : `No REPL vars yet — assign results to variables before printing large outputs.`
  return `REPL stdout:\n${body}${skipNote}\n\n${hint}`
}

/** Stdout ≤ SMALL_STDOUT_LIMIT flows through verbatim; larger output keeps a short head + a note
 *  telling the model how to inspect it in slices. Returns whether elision occurred. */
function formatStdout(r: ReplResult): { text: string; elided: boolean } {
  const out = r.stdout.trim()
  if (!out) return { text: '(no stdout)', elided: false }
  if (out.length <= SMALL_STDOUT_LIMIT) return { text: out, elided: false }
  const cut = out.length - STDOUT_PREVIEW_LIMIT - STDOUT_TAIL_LIMIT
  return {
    text: [
      out.slice(0, STDOUT_PREVIEW_LIMIT),
      `[… ${cut} chars elided — full output stays in REPL vars; inspect slices: print(result[:500])]`,
      out.slice(-STDOUT_TAIL_LIMIT),
    ].join('\n'),
    elided: true,
  }
}
