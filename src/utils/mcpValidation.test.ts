import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { truncateMcpContent } from './mcpValidation.js'
import { isWellFormedText } from './wellFormedText.js'

describe('truncateMcpContent', () => {
  const previous = process.env.MAX_MCP_OUTPUT_TOKENS

  beforeEach(() => {
    // maxChars = tokens * 4 → 1 token = 4 chars.
    process.env.MAX_MCP_OUTPUT_TOKENS = '1'
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS
    else process.env.MAX_MCP_OUTPUT_TOKENS = previous
  })

  test('string truncation never splits a surrogate pair', async () => {
    // Indices 3 (high) and 4 (low) straddle the 4-char cut.
    const content = 'abc😀xxxx'
    const result = (await truncateMcpContent(content)) as string
    expect(result.startsWith('abc')).toBe(true)
    expect(result.startsWith('abc😀')).toBe(false)
    expect(isWellFormedText(result)).toBe(true)
  })

  test('text-block truncation never splits a surrogate pair', async () => {
    // Indices 3 (high) and 4 (low) straddle the 4-char cut.
    const result = (await truncateMcpContent([
      { type: 'text', text: 'abc😀z' },
    ])) as Array<{ type: string; text: string }>
    const text = result[0]!.text
    expect(text).toBe('abc')
    expect(isWellFormedText(text)).toBe(true)
  })
})
