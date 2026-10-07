import { describe, expect, test } from 'bun:test'
import { completionToChunks } from './openaiCompletionToChunks.js'
import { UpstreamStreamError } from './upstreamError.js'

describe('completionToChunks', () => {
  test('a finished completion becomes delta + finish chunks', () => {
    const chunks = completionToChunks({
      id: 'cc1',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello', reasoning: 'thinking' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    })
    expect(chunks).toHaveLength(2)
    const delta = (chunks[0]!.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta
    expect(delta.content).toBe('hello')
    expect(delta.reasoning_content).toBe('thinking')
    const finish = chunks[1] as { choices: Array<{ finish_reason: string }>; usage?: unknown }
    expect(finish.choices[0]!.finish_reason).toBe('stop')
    expect(finish.usage).toBeDefined()
  })

  test('tool calls keep order via index', () => {
    const chunks = completionToChunks({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
              { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    const calls = (chunks[0]!.choices as Array<{ delta: { tool_calls: Array<{ index: number }> } }>)[0]!.delta.tool_calls
    expect(calls.map(c => c.index)).toEqual([0, 1])
  })

  test('typed reasoning_details pass through on the first chunk', () => {
    const details = [{ type: 'reasoning.text', text: 'why' }]
    const chunks = completionToChunks({
      choices: [
        { message: { role: 'assistant', content: 'ok', reasoning_details: details }, finish_reason: 'stop' },
      ],
    })
    const delta = (chunks[0]!.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta
    expect(delta.reasoning_details).toEqual(details)
  })

  test('an error body rethrows as an upstream failure', () => {
    expect(() =>
      completionToChunks({ error: { message: 'provider exploded', code: 503 } }),
    ).toThrow(UpstreamStreamError)
  })

  test('a message without a finish reason is rejected', () => {
    expect(() =>
      completionToChunks({ choices: [{ message: { role: 'assistant', content: 'x' } }] }),
    ).toThrow(UpstreamStreamError)
  })
})
