/**
 * Per-turn user prompts for the headless engine (ported from rlm.pi/prompts/user.ts).
 * Also includes prompt constants used by the engine and system prompt module.
 */

export function buildTurnPrompt(
  iteration: number,
  maxIterations: number,
  gateMessage?: string,
): string {
  const prefix = gateMessage ? `${gateMessage}\n\n` : ''
  const body = `Turn ${iteration + 1}/${maxIterations}:`
  if (iteration === 0) {
    return (
      'You have not interacted with the REPL or seen your context yet. Look at the context first; ' +
      `do not provide a final answer yet.\n\n${prefix}${body}`
    )
  }
  return `${prefix}${body}`
}

/** Asked once when the engine runs out of turns without a submitted answer. */
export const FINALIZE_PROMPT =
  'You are out of turns. Finalize NOW: set `answer["content"]` and `answer["ready"] = True` ' +
  '(fenced ```repl```) with your best final answer from everything you have gathered. ' +
  'For file inventories, use the exact paths and counts from `context` or printed REPL output; ' +
  'never invent filenames, omit discovered files, or mix source files with cache artifacts unless ' +
  'the requested scope explicitly includes them. ' +
  'Only if the REPL is unavailable, answer as plain text.'

/** One-shot retrieval-discipline nudge. */
export const RETRIEVAL_NUDGE =
  '[coach] You have not inspected the external context yet — it is NOT included in this ' +
  'chat, and guessing is useless. On THIS turn, call search("...") or grep_context("...") ' +
  'inside a ```repl` block before answering.'

/** One-shot verification-discipline nudge (default OFF). */
export const VERIFICATION_NUDGE =
  '[coach] That answer was submitted suspiciously early and looks under-verified. Before ' +
  'finalizing: recompute the key quantity inside a ```repl` block (show the actual computation, ' +
  'not a restatement), sanity-check it against the source material, and only then set ' +
  'answer["content"] again.'
