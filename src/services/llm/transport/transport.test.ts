import { describe, test, expect } from 'bun:test'
import { httpRequest } from './http.js'
import { parseSSERaw, parseOpenAIChunksFromSSE } from './sse.js'

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

describe('http transport', () => {
  test('passes method/headers/body/url to fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('ok', { status: 200 })
    }
    await httpRequest(
      { url: 'https://example.com/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' },
      fakeFetch as unknown as typeof fetch,
    )
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://example.com/v1/chat/completions')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(calls[0]!.init.body).toBe('{"a":1}')
  })
})

describe('sse framing', () => {
  test('single chunk single event', async () => {
    const stream = sseStream(['data: {"a":1}\n\n'])
    const events: unknown[] = []
    for await (const ev of parseSSERaw(stream)) events.push(ev)
    expect(events.length).toBe(1)
    expect((events[0] as { data: string }).data).toBe('{"a":1}')
  })

  test('multiple events in one chunk', async () => {
    const stream = sseStream(['data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'])
    const events: unknown[] = []
    for await (const ev of parseSSERaw(stream)) events.push(ev)
    expect(events.length).toBe(3)
    expect((events[2] as { data: string }).data).toBe('[DONE]')
  })

  test('chunk split in middle of line', async () => {
    const stream = sseStream(['data: {"a":', '1}\n\n'])
    const events: unknown[] = []
    for await (const ev of parseSSERaw(stream)) events.push(ev)
    expect(events.length).toBe(1)
    expect((events[0] as { data: string }).data).toBe('{"a":1}')
  })

  test('multiple chunks forming multiple events', async () => {
    const stream = sseStream(['data: {"x":1}\n', '\ndata: {"y":2}\n\n'])
    const events: unknown[] = []
    for await (const ev of parseSSERaw(stream)) events.push(ev)
    expect(events.length).toBe(2)
  })

  test('parseOpenAIChunksFromSSE skips [DONE] and invalid JSON', async () => {
    const stream = sseStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: not-json\n\ndata: [DONE]\n\n'])
    const chunks: unknown[] = []
    for await (const c of parseOpenAIChunksFromSSE(stream)) chunks.push(c)
    expect(chunks.length).toBe(1)
    expect((chunks[0] as { choices: Array<{ delta: { content: string } }> }).choices[0]!.delta.content).toBe('hi')
  })

  test('handles event field', async () => {
    const stream = sseStream(['event: response.output_text.delta\ndata: {"x":1}\n\n'])
    const events: unknown[] = []
    for await (const ev of parseSSERaw(stream)) events.push(ev)
    expect((events[0] as { event: string }).event).toBe('response.output_text.delta')
  })
})
