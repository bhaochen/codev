import { describe, test, expect } from 'bun:test'
import { parseSSERaw } from '../transport/sse.js'
import { adaptOpenAIResponsesSSEToAnthropic } from './openaiResponses.js'

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(enc.encode(chunks[i++]!))
    },
  })
}

async function collectResponsesEvents(chunks: string[], model = 'gpt-4o'): Promise<Array<{ type: string; delta?: unknown; text?: string }>> {
  const raw = parseSSERaw(sseStream(chunks))
  const out: Array<Record<string, unknown>> = []
  for await (const ev of adaptOpenAIResponsesSSEToAnthropic(raw, model)) {
    out.push(ev as Record<string, unknown>)
  }
  return out as never
}

async function collectText(chunks: string[]): Promise<string> {
  let text = ''
  for await (const ev of adaptOpenAIResponsesSSEToAnthropic(parseSSERaw(sseStream(chunks)), 'test')) {
    if (ev.type === 'content_block_delta' && (ev.delta as { type: string }).type === 'text_delta') {
      text += (ev.delta as { text: string }).text
    }
  }
  return text
}

describe('openaiResponses adapter', () => {
  test('text delta Hello + world', async () => {
    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ]
    const text = await collectText(chunks)
    expect(text).toBe('Hello world')
  })

  test('completed ends stream with end_turn', async () => {
    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ]
    const events = await collectResponsesEvents(chunks)
    const types = events.map(e => e.type)
    expect(types).toContain('message_start')
    expect(types).toContain('content_block_start')
    expect(types).toContain('content_block_delta')
    expect(types).toContain('content_block_stop')
    expect(types).toContain('message_delta')
    expect(types).toContain('message_stop')
    const delta = events.find(e => e.type === 'message_delta') as { delta: { stop_reason: string } }
    expect(delta.delta.stop_reason).toBe('end_turn')
  })

  test('cross-chunk delta still correct (via framing)', async () => {
    const chunks = ['event: response.output_text.delta\ndata: {"type":"response.output_text', '.delta","delta":"cross"}\n\n', 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n']
    const text = await collectText(chunks)
    expect(text).toBe('cross')
  })

  test('unknown event (response.created) does not crash', async () => {
    const chunks = [
      'event: response.created\ndata: {"type":"response.created","response":{}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]
    const text = await collectText(chunks)
    expect(text).toBe('ok')
  })

  test('does not depend on choices[0].delta (Chat parser)', async () => {
    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"independent"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]
    const events = await collectResponsesEvents(chunks)
    // ensure adapter produced text without ever seeing Chat shape
    const deltas = events.filter(e => e.type === 'content_block_delta') as Array<{ delta: { text: string } }>
    expect(deltas.length).toBe(1)
    expect(deltas[0]!.delta.text).toBe('independent')
  })

  test('invalid JSON data is skipped', async () => {
    const chunks = [
      'event: response.output_text.delta\ndata: not-json\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"good"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]
    const text = await collectText(chunks)
    expect(text).toBe('good')
  })
})
