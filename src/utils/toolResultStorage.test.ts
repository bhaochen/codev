import { describe, expect, test } from 'bun:test'
import { generatePreview } from './toolResultStorage.js'
import { isWellFormedText } from './wellFormedText.js'

const EMOJI = '😀'

describe('generatePreview', () => {
  test('returns the whole content when under the limit', () => {
    expect(generatePreview('short', 100)).toEqual({ preview: 'short', hasMore: false })
  })

  test('never splits a surrogate pair at the cut', () => {
    // Indices 0-8 are 'a'; the emoji occupies 9 (high) and 10 (low).
    const content = `${'a'.repeat(9)}${EMOJI}${'b'.repeat(20)}`
    const { preview, hasMore } = generatePreview(content, 10)
    expect(hasMore).toBe(true)
    expect(preview).toBe('a'.repeat(9))
    expect(isWellFormedText(preview)).toBe(true)
  })

  test('preview is bounded in UTF-8 bytes, not code units', () => {
    const content = '中'.repeat(100) // 300 bytes, 100 code units
    const { preview, hasMore } = generatePreview(content, 30)
    expect(hasMore).toBe(true)
    expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(30)
    expect(isWellFormedText(preview)).toBe(true)
  })

  test('prefers a newline boundary and stays well-formed', () => {
    const content = `${'a'.repeat(40)}\n${'b'.repeat(60)}${EMOJI}`
    const { preview } = generatePreview(content, 50)
    expect(preview).toBe('a'.repeat(40))
    expect(isWellFormedText(preview)).toBe(true)
  })
})
