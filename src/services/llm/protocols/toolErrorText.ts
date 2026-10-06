/**
 * Mark failed tool results in their text, for wires that cannot flag them.
 *
 * The Anthropic wire carries a tool_result's `is_error`, and so do a few
 * others. OpenAI Chat `role: "tool"` messages and the Responses API's
 * `function_call_output` have no such field, so there the flag is dropped and
 * an error thrown by a tool (a crashed PDF tool, a missing file) reads like
 * the tool's normal output. Validation errors already arrive wrapped in
 * `<tool_use_error>`; this gives thrown errors the same wrapper, so a model on
 * any wire can tell a failure from a result.
 *
 * Pure and deterministic: the same history always yields the same text, so the
 * serialized prefix and any provider prompt cache stay stable across turns.
 * The stored conversation is never changed, only the copy handed to the wire.
 */

const OPEN = '<tool_use_error>'
const CLOSE = '</tool_use_error>'

type TextPart = { type: string; text?: string }

/**
 * Wrap `content` in `<tool_use_error>` when `isError` is true, unless it is
 * already wrapped. Returns `content` unchanged otherwise.
 */
export function markToolErrorText<T>(content: T, isError: boolean | undefined): T {
  if (isError !== true) return content

  if (typeof content === 'string') {
    return (
      content.includes(OPEN) ? content : `${OPEN}${content}${CLOSE}`
    ) as T
  }
  if (content === undefined || content === null) {
    return `${OPEN}${CLOSE}` as T
  }
  if (!Array.isArray(content)) return content

  const parts = content as unknown as TextPart[]
  // Error results are text-only by construction (the Anthropic API rejects
  // anything else), but keep any other block where it is.
  const textIndexes = parts.flatMap((b, i) => (b?.type === 'text' ? [i] : []))
  if (textIndexes.some(i => parts[i]!.text?.includes(OPEN))) {
    return content
  }
  if (textIndexes.length === 0) {
    return [{ type: 'text', text: `${OPEN}${CLOSE}` }, ...parts] as T
  }
  const first = textIndexes[0]!
  const last = textIndexes[textIndexes.length - 1]!
  return parts.map((b, i) => {
    if (i !== first && i !== last) return b
    const text = `${i === first ? OPEN : ''}${b.text ?? ''}${i === last ? CLOSE : ''}`
    return { ...b, text }
  }) as T
}
