import { describe, expect, test } from 'bun:test'
import { truncateUtf8ToBytes } from './utf8.js'
import { isWellFormedText } from './wellFormedText.js'

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

describe('truncateUtf8ToBytes', () => {
  test('returns the same string when it already fits', () => {
    const s = 'hello'
    expect(truncateUtf8ToBytes(s, 5)).toBe(s)
    expect(truncateUtf8ToBytes(s, 100)).toBe(s)
  })

  test('cuts CJK on a real byte boundary, not by code units', () => {
    const s = '中'.repeat(10) // 30 bytes
    const out = truncateUtf8ToBytes(s, 10)
    expect(out).toBe('中'.repeat(3)) // 3 × 3 bytes = 9 ≤ 10
    expect(bytes(out)).toBeLessThanOrEqual(10)
  })

  test('never leaves half a surrogate pair', () => {
    const s = `a😀b`
    expect(truncateUtf8ToBytes(s, 5)).toBe('a😀') // exactly 5 bytes
    const out = truncateUtf8ToBytes(s, 2) // cannot fit the 4-byte emoji
    expect(out).toBe('a')
    expect(isWellFormedText(out)).toBe(true)
  })

  test('a non-positive budget yields empty', () => {
    expect(truncateUtf8ToBytes('abc', 0)).toBe('')
    expect(truncateUtf8ToBytes('abc', -1)).toBe('')
  })
})
