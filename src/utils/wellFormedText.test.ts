import { describe, expect, test } from 'bun:test'
import {
  isWellFormedText,
  surrogateSafeEnd,
  surrogateSafeStart,
  toWellFormedText,
} from './wellFormedText.js'

const EMOJI = '😀' // U+1F600, a surrogate pair
const HIGH = '\ud83d' // lone high surrogate
const LOW = '\ude00' // lone low surrogate

describe('isWellFormedText', () => {
  test('accepts plain text and valid astral pairs', () => {
    expect(isWellFormedText('hello')).toBe(true)
    expect(isWellFormedText(`a${EMOJI}b`)).toBe(true)
    expect(isWellFormedText('')).toBe(true)
  })

  test('rejects lone surrogates', () => {
    expect(isWellFormedText(`a${HIGH}b`)).toBe(false)
    expect(isWellFormedText(`a${LOW}b`)).toBe(false)
    expect(isWellFormedText(HIGH)).toBe(false)
  })
})

describe('toWellFormedText', () => {
  test('returns the same string when already well-formed', () => {
    const text = `a${EMOJI}b`
    expect(toWellFormedText(text)).toBe(text)
  })

  test('replaces lone surrogates with U+FFFD while keeping valid pairs', () => {
    const repaired = toWellFormedText(`${EMOJI}x${HIGH}y${LOW}z`)
    expect(repaired).toBe(`${EMOJI}x\uFFFDy\uFFFDz`)
    // The repaired text must serialize to parseable JSON.
    expect(() => JSON.parse(JSON.stringify({ repaired }))).not.toThrow()
  })
})

describe('surrogateSafeEnd / surrogateSafeStart', () => {
  const text = `a${EMOJI}b` // indices: 0='a', 1=high, 2=low, 3='b'

  test('end steps back off a split pair', () => {
    expect(surrogateSafeEnd(text, 2)).toBe(1)
    expect(surrogateSafeEnd(text, 3)).toBe(3)
    expect(surrogateSafeEnd(text, 0)).toBe(0)
  })

  test('start steps forward off a split pair', () => {
    expect(surrogateSafeStart(text, 2)).toBe(3)
    expect(surrogateSafeStart(text, 1)).toBe(1)
    expect(surrogateSafeStart(text, text.length)).toBe(text.length)
  })

  test('slices never contain a lone surrogate', () => {
    for (let i = 0; i <= text.length; i++) {
      expect(isWellFormedText(text.slice(0, surrogateSafeEnd(text, i)))).toBe(true)
      expect(isWellFormedText(text.slice(surrogateSafeStart(text, i)))).toBe(true)
    }
  })

  test('clamps out-of-range indices', () => {
    expect(surrogateSafeEnd(text, -5)).toBe(0)
    expect(surrogateSafeEnd(text, 999)).toBe(text.length)
    expect(surrogateSafeStart(text, -5)).toBe(0)
    expect(surrogateSafeStart(text, 999)).toBe(text.length)
  })
})
