/**
 * Shared history mutation helpers for the engine loop.
 *
 * Ported from rlm.pi/pi-plugin/rlm/src/core/history.ts.
 */

import type { ChatMsg } from './adapter.js'

/** Append content to the last user message if adjacent, otherwise push a new user message. */
export function appendUserMessage(history: ChatMsg[], content: string): void {
  const last = history.at(-1)
  if (last?.role === 'user') {
    history[history.length - 1] = { role: 'user', content: [last.content, content].join('\n\n') }
    return
  }
  history.push({ role: 'user', content })
}
