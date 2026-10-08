/**
 * Output-cap truncation — one rule for every provider.
 *
 * When a provider stops generating because the response hit the output-token
 * ceiling, the last thing the model was writing is half-written. If that was a
 * tool call, its arguments are a fragment: sometimes unparseable JSON, but —
 * the failure that motivated this module — sometimes a *complete* JSON object
 * that is simply missing the fields the model had not reached yet.
 *
 * So a client must do two things when the provider reports truncation:
 *
 *   - Emit `stop_reason: 'max_tokens'`. The turn then takes the recovery path
 *     (retry at a higher cap, else re-prompt the model to resume) instead of
 *     settling as finished.
 *   - Drop the tool call that was still receiving argument deltas. It is the
 *     only block that can be half-written, and it has no tool_result yet, so
 *     dropping it keeps the tool_use/tool_result pairing intact. The model
 *     re-issues it on the next turn.
 */

/** Anthropic-IR stop reasons a provider turn may report. */
export type LaneStopReason = 'end_turn' | 'tool_use' | 'max_tokens'

/**
 * Every spelling of "stopped because the output cap was reached":
 *   - `length`             OpenAI Chat Completions `choice.finish_reason`
 *   - `max_output_tokens`  OpenAI Responses `response.incomplete_details.reason`
 *   - `max_tokens`         Gemini / routers passing an Anthropic stop_reason
 */
const OUTPUT_CAP_REASONS = new Set(['length', 'max_output_tokens', 'max_tokens'])

/** Did the provider stop because the response hit the output-token ceiling? */
export function isOutputCapTruncation(reason: unknown): boolean {
  return (
    typeof reason === 'string' &&
    OUTPUT_CAP_REASONS.has(reason.trim().toLowerCase())
  )
}

/**
 * The stop reason for a finished turn. Truncation outranks `tool_use`: the turn
 * did end with tool calls, but what the caller must act on is the truncation.
 * `hadToolUse` counts the blocks actually emitted — a dropped in-flight call is
 * not one of them.
 */
export function laneStopReason(opts: {
  truncated: boolean
  hadToolUse: boolean
}): LaneStopReason {
  if (opts.truncated) return 'max_tokens'
  return opts.hadToolUse ? 'tool_use' : 'end_turn'
}

/**
 * Tracks which tool call was mid-flight when the stream ended.
 *
 * Providers stream tool calls one at a time, so only the call that most
 * recently received an argument delta can be half-written. Text or reasoning
 * arriving afterwards proves the model moved on and closed that call, so the
 * tracker forgets it — a complete call is never dropped just because the cut
 * happened later in the same turn.
 *
 * `K` is whatever the caller keys its argument buffers by (an OpenAI tool_call
 * index, a Responses output index, …).
 */
export class InFlightToolCall<K> {
  private key: K | null = null

  /** An argument fragment arrived for `key`. */
  noteArgs(key: K): void {
    this.key = key
  }

  /** Text / reasoning arrived — whatever tool call preceded it is closed. */
  noteOtherOutput(): void {
    this.key = null
  }

  /** The provider explicitly finished this call. */
  noteSettled(key: K): void {
    if (this.key === key) this.key = null
  }

  /**
   * The call to discard when `truncated`, or null when nothing was in flight.
   * Returns null unless truncated, so callers can write the drop unguarded.
   */
  toDrop(truncated: boolean): K | null {
    return truncated ? this.key : null
  }
}
