import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { stripObservableBackfill } from './observableInput.js'
import type { Tool } from '../Tool.js'

function backfillingTool(
  backfill: (input: Record<string, unknown>) => void,
): Tool {
  return {
    name: 'T',
    inputSchema: z.object({ file_path: z.string() }),
    backfillObservableInput: backfill,
  } as unknown as Tool
}

describe('stripObservableBackfill', () => {
  test('removes an observer-only field the backfill reproduces', () => {
    const tool = backfillingTool(input => {
      input.resolved_path = '/abs/x'
    })
    const input: Record<string, unknown> = {
      file_path: 'x',
      resolved_path: '/abs/x',
    }
    expect(stripObservableBackfill(tool, input)).toEqual({ file_path: 'x' })
  })

  test('keeps the input when a model-written extra is not reproduced', () => {
    const tool = backfillingTool(input => {
      input.resolved_path = '/abs/x'
    })
    const input = { file_path: 'x', user_extra: 1 }
    expect(stripObservableBackfill(tool, input)).toBe(input)
  })

  test('returns the same reference when nothing is outside the schema', () => {
    const tool = backfillingTool(() => {})
    const input = { file_path: 'x' }
    expect(stripObservableBackfill(tool, input)).toBe(input)
  })

  test('a tool without backfill is a no-op', () => {
    const tool = { name: 'T', inputSchema: z.object({ a: z.string() }) } as unknown as Tool
    const input = { a: 'x', extra: 1 }
    expect(stripObservableBackfill(tool, input)).toBe(input)
  })

  test('a throwing backfill leaves the input alone', () => {
    const tool = backfillingTool(() => {
      throw new Error('nope')
    })
    const input = { file_path: 'x', observer: 1 }
    expect(stripObservableBackfill(tool, input)).toBe(input)
  })

  test('non-object input is untouched', () => {
    const tool = backfillingTool(() => {})
    expect(stripObservableBackfill(tool, 'str')).toBe('str')
    expect(stripObservableBackfill(tool, [1, 2])).toEqual([1, 2])
  })
})
