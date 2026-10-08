/**
 * Keep observer-only tool input fields out of API requests.
 *
 * A tool may backfill legacy or derived fields into a tool_use input for its
 * observers (the SDK stream, the transcript, hooks). The yielded clone is what
 * the session keeps, so from the next turn the provider would receive a tool
 * call the model never wrote — changing the bytes of an already-cached turn.
 *
 * Only keys outside the tool's declared input schema are candidates, and they
 * are dropped only when re-running the tool's own backfill on what remains
 * reproduces the input exactly. Anything the model itself sent is kept.
 */

import type { Tool } from '../Tool.js'

export function stripObservableBackfill<I>(tool: Tool, input: I): I {
  const backfill = tool.backfillObservableInput
  if (!backfill) return input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const shape = (tool.inputSchema as unknown as { shape?: unknown } | undefined)
    ?.shape
  if (!shape || typeof shape !== 'object') return input

  const record = input as Record<string, unknown>
  const extraKeys = Object.keys(record).filter(key => !Object.hasOwn(shape, key))
  if (extraKeys.length === 0) return input

  const original: Record<string, unknown> = { ...record }
  for (const key of extraKeys) delete original[key]
  const rebuilt: Record<string, unknown> = { ...original }
  try {
    backfill.call(tool, rebuilt)
  } catch {
    return input
  }
  return JSON.stringify(rebuilt) === JSON.stringify(record) ? (original as I) : input
}
