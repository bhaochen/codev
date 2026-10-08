/**
 * Truncate a string to a UTF-8 byte budget without splitting a code point.
 *
 * `String.prototype.length` counts UTF-16 code units, so a budget named in
 * bytes silently overruns by up to ~4x on CJK or emoji text. This cuts at a
 * real byte boundary and steps back off a surrogate pair, so the result is
 * always ≤ `maxBytes` bytes and never ends in half an astral character.
 */

import { surrogateSafeEnd } from './wellFormedText.js'

export function truncateUtf8ToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value

  // Largest UTF-16 prefix whose UTF-8 encoding fits the budget.
  let lo = 0
  let hi = value.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return value.slice(0, surrogateSafeEnd(value, lo))
}
