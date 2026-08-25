import { describe, expect, test } from 'bun:test'
import { DeepSearchTool } from '../DeepSearchTool.js'
import { getToolUseSummary } from '../UI.js'

describe('DeepSearchTool inputSchema', () => {
  test('applies defaults for empty input', () => {
    const parsed = DeepSearchTool.inputSchema.safeParse({})
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.dataset).toBe('deepsearch-demo')
    expect(parsed.data.maxSteps).toBe(8)
    expect(parsed.data.judge).toBe(true)
    expect(parsed.data.score).toBe(true)
    expect(parsed.data.model).toBeUndefined()
  })

  test('accepts explicit dataset / model / maxSteps / limit', () => {
    const parsed = DeepSearchTool.inputSchema.safeParse({
      dataset: 'path/to/ds.json',
      model: 'openai/gpt-oss-120b',
      maxSteps: 4,
      limit: 2,
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.dataset).toBe('path/to/ds.json')
    expect(parsed.data.model).toBe('openai/gpt-oss-120b')
    expect(parsed.data.maxSteps).toBe(4)
    expect(parsed.data.limit).toBe(2)
  })

  test('rejects invalid maxSteps', () => {
    expect(
      DeepSearchTool.inputSchema.safeParse({ maxSteps: 0 }).success,
    ).toBe(false)
    expect(
      DeepSearchTool.inputSchema.safeParse({ maxSteps: 51 }).success,
    ).toBe(false)
  })
})

describe('DeepSearchTool mapToolResultToToolResultBlockParam', () => {
  test('wraps report text in a text block', () => {
    const block = DeepSearchTool.mapToolResultToToolResultBlockParam(
      '📊 report',
      'toolu_abc',
    )
    expect(block.tool_use_id).toBe('toolu_abc')
    expect(block.type).toBe('tool_result')
    expect(block.content).toEqual([{ type: 'text', text: '📊 report' }])
  })
})

describe('DeepSearchTool UI helpers', () => {
  test('getToolUseSummary returns dataset (+model)', () => {
    expect(getToolUseSummary({ dataset: 'deepsearch-demo' })).toBe(
      'deepsearch-demo',
    )
    expect(getToolUseSummary({ dataset: 'ds', model: 'm' })).toBe('ds · m')
    expect(getToolUseSummary(undefined)).toBeNull()
  })

  test('renderToolResultMessage renders the report text', () => {
    const node = DeepSearchTool.renderToolResultMessage?.(
      '▍metrics\n  accuracy 4/4',
      [],
      {
        theme: 'dark' as never,
        tools: [],
        verbose: true,
      },
    )
    expect(node).not.toBeNull()
    expect(node).not.toBeUndefined()
  })
})
