import { describe, expect, test } from 'bun:test'
import { sanitizeToolCallAdjacency } from './sanitizeToolAdjacency.js'
import type { OpenAIChatMessage } from './openaiChatWire.js'

function assistantWithCalls(ids: string[], content: string | null = null): OpenAIChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: ids.map(id => ({
      id,
      type: 'function' as const,
      function: { name: 'mock', arguments: '{}' },
    })),
  }
}

describe('sanitizeToolCallAdjacency', () => {
  test('orphan tool result is dropped', () => {
    const out = sanitizeToolCallAdjacency([
      { role: 'tool', content: 'nobody asked', tool_call_id: 'ghost' },
      { role: 'user', content: 'hi' },
    ])
    expect(out).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('unanswered tool_calls are removed from the assistant message', () => {
    const out = sanitizeToolCallAdjacency([
      assistantWithCalls(['a', 'b']),
      { role: 'tool', content: 'done', tool_call_id: 'a' },
      { role: 'user', content: 'next' },
    ])
    expect(out[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'mock', arguments: '{}' } },
      ],
    })
    expect(out).toHaveLength(3)
  })

  test('a tool result arriving after another message is dropped', () => {
    const out = sanitizeToolCallAdjacency([
      assistantWithCalls(['a']),
      { role: 'user', content: 'interrupt' },
      { role: 'tool', content: 'late', tool_call_id: 'a' },
    ])
    // The assistant loses its unanswered call; the late tool is not adjacent.
    expect(out[0]).toEqual({ role: 'assistant', content: '', tool_calls: undefined })
    expect(out.map(m => m.role)).toEqual(['assistant', 'user'])
  })

  test('duplicate ids collapse and empty content becomes a string', () => {
    const out = sanitizeToolCallAdjacency([
      assistantWithCalls(['a', 'a']),
      { role: 'tool', content: 'done', tool_call_id: 'a' },
    ])
    expect(out[0]!.tool_calls).toHaveLength(1)
  })

  test('a valid sequence passes through byte-identically', () => {
    const input: OpenAIChatMessage[] = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hi' },
      assistantWithCalls(['a', 'b']),
      { role: 'tool', content: 'one', tool_call_id: 'a' },
      { role: 'tool', content: 'two', tool_call_id: 'b' },
      { role: 'user', content: 'next' },
    ]
    expect(sanitizeToolCallAdjacency(input)).toEqual(input)
  })
})
