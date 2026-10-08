import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetOpenRouterToolFreezeForTest,
  freezeOpenRouterTools,
} from './openrouterToolFreeze.js'
import type { OpenAIChatTool } from './openaiChatWire.js'

function tool(
  name: string,
  description = `${name} desc`,
  parameters: Record<string, unknown> = { type: 'object', properties: {} },
): OpenAIChatTool {
  return { type: 'function', function: { name, description, parameters } }
}

const names = (tools: OpenAIChatTool[]) => tools.map(t => t.function.name)

describe('freezeOpenRouterTools', () => {
  beforeEach(() => _resetOpenRouterToolFreezeForTest())

  test('first call seeds the snapshot in order', () => {
    const out = freezeOpenRouterTools('k1', [tool('A'), tool('B'), tool('C')])
    expect(names(out)).toEqual(['A', 'B', 'C'])
  })

  test('reordering and description churn keep the frozen prefix', () => {
    freezeOpenRouterTools('k2', [tool('A', 'a1'), tool('B', 'b1')])
    const out = freezeOpenRouterTools('k2', [
      tool('B', 'CHANGED'),
      tool('A', 'CHANGED'),
    ])
    expect(names(out)).toEqual(['A', 'B'])
    expect(out[0]!.function.description).toBe('a1')
    expect(out[1]!.function.description).toBe('b1')
  })

  test('a removed tool is dropped but keeps its slot on return', () => {
    freezeOpenRouterTools('k3', [tool('A'), tool('B'), tool('C')])
    expect(names(freezeOpenRouterTools('k3', [tool('A'), tool('C')]))).toEqual([
      'A',
      'C',
    ])
    expect(
      names(freezeOpenRouterTools('k3', [tool('A'), tool('B'), tool('C')])),
    ).toEqual(['A', 'B', 'C'])
  })

  test('a genuinely new tool is appended at the end', () => {
    freezeOpenRouterTools('k4', [tool('A')])
    expect(names(freezeOpenRouterTools('k4', [tool('A'), tool('D')]))).toEqual([
      'A',
      'D',
    ])
  })

  test('a changed parameter schema is adopted in place', () => {
    freezeOpenRouterTools('k5', [tool('A'), tool('B')])
    const out = freezeOpenRouterTools('k5', [
      tool('A', 'A desc', { type: 'object', properties: { x: { type: 'string' } } }),
      tool('B'),
    ])
    expect(names(out)).toEqual(['A', 'B'])
    expect(out[0]!.function.parameters).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    })
  })

  test('different keys do not share snapshots', () => {
    freezeOpenRouterTools('k6a', [tool('A'), tool('B')])
    const out = freezeOpenRouterTools('k6b', [tool('B'), tool('A')])
    expect(names(out)).toEqual(['B', 'A'])
  })

  test('returned tools are copies, not snapshot references', () => {
    const out = freezeOpenRouterTools('k7', [tool('A')])
    out[0]!.function.description = 'mutated'
    const again = freezeOpenRouterTools('k7', [tool('A')])
    expect(again[0]!.function.description).toBe('A desc')
  })
})
