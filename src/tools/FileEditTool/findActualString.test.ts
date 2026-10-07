import { describe, expect, test } from 'bun:test'
import { findActualString } from './utils.js'

describe('findActualString', () => {
  test('exact match wins', () => {
    expect(findActualString('const a = 1\n', 'const a = 1')).toBe('const a = 1')
  })

  test('quote normalization still matches', () => {
    const file = 'const s = \u201chello\u201d\n'
    expect(findActualString(file, 'const s = "hello"')).toBe('const s = \u201chello\u201d')
  })

  test('per-line whitespace differences match when enabled, returning file bytes', () => {
    const file = 'function f() {\n    return 1;\n}\n'
    const model = 'function f() {\n  return 1;  \n}'
    expect(findActualString(file, model, { whitespaceFlexible: true })).toBe(
      'function f() {\n    return 1;\n}',
    )
  })

  test('lenient rung is off by default', () => {
    const file = 'a  =  1\n'
    expect(findActualString(file, 'a = 1')).toBeNull()
    expect(findActualString(file, 'a = 1', { whitespaceFlexible: true })).toBe('a  =  1')
  })

  test('line count and non-whitespace characters must still match', () => {
    const file = 'const a = 1\n'
    expect(findActualString(file, 'const b = 1', { whitespaceFlexible: true })).toBeNull()
    expect(findActualString(file, 'const a = 1\nconst b = 2', { whitespaceFlexible: true })).toBeNull()
  })

  test('a whitespace-only search never matches leniently', () => {
    expect(findActualString('abc\n', '   ', { whitespaceFlexible: true })).toBeNull()
  })

  test('returns the exact span for multi-line CRLF content', () => {
    const file = 'a\r\nb\r\nc\r\n'
    expect(findActualString(file, 'a\nb', { whitespaceFlexible: true })).toBe('a\r\nb')
  })
})
