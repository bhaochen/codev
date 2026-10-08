import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { coerceToolInput } from './coerceToolInput.js'

describe('coerceToolInput', () => {
  test('string → array', () => {
    const schema = z.object({ items: z.array(z.string()) })
    expect(coerceToolInput({ items: '["a","b"]' }, schema)).toEqual({
      items: ['a', 'b'],
    })
  })

  test('string → object', () => {
    const schema = z.object({ opts: z.object({ a: z.number() }) })
    expect(coerceToolInput({ opts: '{"a":1}' }, schema)).toEqual({
      opts: { a: 1 },
    })
  })

  test('string → number', () => {
    const schema = z.object({ n: z.number() })
    expect(coerceToolInput({ n: '5' }, schema)).toEqual({ n: 5 })
  })

  test('string → boolean', () => {
    const schema = z.object({ b: z.boolean() })
    expect(coerceToolInput({ b: 'true' }, schema)).toEqual({ b: true })
  })

  test('number/boolean → string', () => {
    const schema = z.object({ s: z.string() })
    expect(coerceToolInput({ s: 3 }, schema)).toEqual({ s: '3' })
  })

  test('recovers a near-miss key spelling', () => {
    const schema = z.object({ file_path: z.string() })
    expect(coerceToolInput({ filePath: 'x.ts' }, schema)).toEqual({
      file_path: 'x.ts',
    })
  })

  test('drops null for an optional field', () => {
    const schema = z.object({ note: z.string().optional() })
    expect(coerceToolInput({ note: null }, schema)).toEqual({})
  })

  test('already-valid input is returned unchanged (same reference)', () => {
    const schema = z.object({ n: z.number() })
    const input = { n: 5 }
    expect(coerceToolInput(input, schema)).toBe(input)
  })

  test('recovers a fenced _raw sentinel', () => {
    const schema = z.object({ a: z.number() })
    expect(coerceToolInput({ _raw: '```json\n{"a":1}\n```' }, schema)).toEqual({
      a: 1,
    })
  })

  test('under-escaped backslashes recover losslessly', () => {
    const schema = z.object({ path: z.string() })
    // \U is not a valid JSON escape; the intended value is a literal backslash.
    const result = coerceToolInput({ _raw: String.raw`{"path":"C:\Users\ok"}` }, schema)
    expect(result).toEqual({ path: String.raw`C:\Users\ok` })
  })
})
