import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { formatError, formatZodValidationError } from './toolErrors.js'
import { isWellFormedText } from './wellFormedText.js'

describe('formatError', () => {
  test('returns short messages unchanged', () => {
    expect(formatError(new Error('boom'))).toBe('boom')
  })

  test('truncates long messages without splitting a surrogate pair', () => {
    // The emoji straddles the 5000-unit cut: index 4999 high, 5000 low.
    const full = `${'a'.repeat(4999)}😀${'b'.repeat(12000)}`
    const result = formatError(new Error(full))
    expect(isWellFormedText(result)).toBe(true)
    // 17001 total, head 4999, tail 5000 → 7002 removed.
    expect(result).toContain('7002 characters truncated')
    expect(result.startsWith('a'.repeat(4999))).toBe(true)
  })

  test('the removed-character count is the real head+tail loss', () => {
    const full = 'x'.repeat(25_000)
    const result = formatError(new Error(full))
    expect(result).toContain('15000 characters truncated')
  })
})

describe('formatZodValidationError', () => {
  const schema = z.strictObject({ name: z.string(), count: z.number() })

  test('summarizes missing and unexpected parameters', () => {
    const parsed = schema.safeParse({ nmae: 'x' })
    expect(parsed.success).toBe(false)
    const message = formatZodValidationError(
      'MyTool',
      parsed.error!,
      schema,
      { nmae: 'x' },
    )
    expect(message).toContain('MyTool failed due to the following')
    expect(message).toContain('`name` is missing')
    expect(message).toContain('An unexpected parameter `nmae` was provided')
    expect(message).toContain('Expected input schema:')
    expect(message).toContain('"name"')
    expect(message).toContain('Received input:')
    expect(message).toContain('nmae')
  })

  test('omits schema and input sections when not provided', () => {
    const parsed = schema.safeParse({})
    const message = formatZodValidationError('MyTool', parsed.error!)
    expect(message).not.toContain('Expected input schema:')
    expect(message).not.toContain('Received input:')
  })
})
