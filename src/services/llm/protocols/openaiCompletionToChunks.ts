/**
 * Turn a non-streaming Chat Completions response into the chunk sequence the
 * streaming adapter already understands.
 *
 * The recovery attempt after an upstream stream failure is sent with
 * `stream: false`: the provider returns one complete JSON completion, which
 * cannot fail midway. Converting it to the ordinary chunk shape means the
 * validation, tool-call assembly and usage accounting are byte-for-byte the
 * same code paths as a stream (no second parser to drift).
 */
import {
  UpstreamStreamError,
  upstreamFailureFromChunk,
} from './upstreamError.js'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * @throws UpstreamStreamError when the completion itself reports a failure or
 * is not a completed message.
 */
export function completionToChunks(
  completion: unknown,
): Record<string, unknown>[] {
  const body = asRecord(completion)
  if (!body) {
    throw new UpstreamStreamError({
      message: 'The recovery response was not a completion object.',
      capacity: false,
    })
  }

  // An error body on the recovery attempt is the same upstream failure again.
  const failure = upstreamFailureFromChunk(body)
  if (failure) throw new UpstreamStreamError(failure)

  const choices = Array.isArray(body.choices) ? body.choices : []
  const choice = asRecord(choices[0])
  const message = asRecord(choice?.message)
  const finish =
    typeof choice?.finish_reason === 'string'
      ? choice.finish_reason
      : typeof choice?.native_finish_reason === 'string'
        ? choice.native_finish_reason
        : undefined
  if (!choice || !message || !finish) {
    throw new UpstreamStreamError({
      message: 'The recovery response has no completed message.',
      capacity: false,
    })
  }

  const delta: Record<string, unknown> = { role: 'assistant' }
  if (typeof message.content === 'string' && message.content.length > 0) {
    delta.content = message.content
  }
  const reasoning = message.reasoning ?? message.reasoning_content
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    delta.reasoning_content = reasoning
  }
  if (Array.isArray(message.reasoning_details)) {
    delta.reasoning_details = message.reasoning_details
  }
  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = message.tool_calls.map((call, index) => ({
      ...asRecord(call),
      index,
    }))
  }

  const id = typeof body.id === 'string' ? body.id : 'recovery'
  const model = typeof body.model === 'string' ? body.model : undefined
  return [
    { id, model, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      id,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      ...(asRecord(body.usage) ? { usage: body.usage } : {}),
    },
  ]
}
