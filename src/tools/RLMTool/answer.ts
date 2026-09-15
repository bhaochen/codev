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

/** Last non-empty stdout across a turn's blocks. A run that ends without an
 *  `answer[...]` frame still printed its winning value, and re-running the whole task to get it
 *  is a waste (and non-deterministic). Keep it intact so generated reports do not lose edges. */
export function latestStdoutOf(results: readonly ReplResult[]): string {
  for (let i = results.length - 1; i >= 0; i--) {
    const out = results[i]?.stdout.trim()
    if (out) return out
  }
  return ''
}

/** True if any block in the turn raised an exception. Plain stderr does not count. */
export function turnHadError(results: readonly ReplResult[]): boolean {
  return results.some((r) => r.raised)
}

/** The REPL output fed back to the model as the next user message. Prefixed `REPL stdout:`. */
export function formatReplOutputs(results: readonly ReplResult[], skippedBlocks = 0): string {
  if (results.length === 0) {
    return 'No ```repl``` block found in your response. Write one to interact with the REPL.'
  }
  const multi = results.length > 1
  const parts = new Array<string>(results.length)
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const head = multi ? `[block ${i + 1}]\n` : ''
    const text = formatStdout(r)
    parts[i] = `${head}${text}${formatReplStderr(r.stderr)}`
  }
  const body = parts.join('\n\n')
  const skipNote =
    skippedBlocks > 0
      ? `\n\n[${skippedBlocks} later \`\`\`repl\`\`\` block(s) skipped because an earlier block raised — fix and re-run them]`
      : ''
  return `REPL stdout:\n${body}${skipNote}`
}

/** Preserve stdout verbatim. Import/export reports and generated graphs depend on middle lines. */
function formatStdout(r: ReplResult): string {
  const out = r.stdout.trim()
  return out || '(no stdout)'
}
