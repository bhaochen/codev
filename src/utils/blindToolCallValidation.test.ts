import { describe, expect, test } from 'bun:test'
import { checkUnknownToolArguments } from './blindToolCallValidation.js'
import type { Tool } from '../Tool.js'

function tool(partial: Record<string, unknown>): Tool {
  return { name: 'mcp__srv__do', ...partial } as unknown as Tool
}

describe('checkUnknownToolArguments', () => {
  test('ignores tools without a JSON Schema', () => {
    expect(
      checkUnknownToolArguments(tool({}), { anything: 1 }),
    ).toEqual({ ok: true })
  })

  test('ignores schemas that allow additional properties', () => {
    const t = tool({
      inputJSONSchema: { type: 'object', properties: { a: {} } },
    })
    expect(checkUnknownToolArguments(t, { a: 1, extra: 2 })).toEqual({ ok: true })
  })

  test('rejects an undeclared key when additionalProperties is false', () => {
    const t = tool({
      inputJSONSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { query: { type: 'string' } },
      },
    })
    expect(checkUnknownToolArguments(t, { query: 'a' })).toEqual({ ok: true })
    const result = checkUnknownToolArguments(t, { query: 'a', bogus: 1 })
    expect(result.ok).toBe(false)
    const message = (result as { message: string }).message
    expect(message).toContain('`bogus`')
    expect(message).toContain('query')
  })

  test('a patternProperties match is not unknown', () => {
    const t = tool({
      inputJSONSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        patternProperties: { '^x-': {} },
      },
    })
    expect(checkUnknownToolArguments(t, { 'x-trace': '1' })).toEqual({ ok: true })
  })

  test('a malformed pattern in a third-party schema never crashes', () => {
    const t = tool({
      inputJSONSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { a: {} },
        patternProperties: { '[': {} },
      },
    })
    expect(checkUnknownToolArguments(t, { a: 1 })).toEqual({ ok: true })
    expect(checkUnknownToolArguments(t, { z: 1 }).ok).toBe(false)
  })
})
