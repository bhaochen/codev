import { describe, expect, spyOn, test } from 'bun:test'
import { fetchHttpRung } from './httpRung.js'

const MAX_BODY_BYTES = 25 * 1024 * 1024

function oversizedResponse(contentType: string, onCancel: () => void): Response {
  const chunk = new Uint8Array(1024 * 1024)
  let chunksSent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunksSent++ < 26) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() {
      onCancel()
    },
  }, { highWaterMark: 0 })
  return new Response(body, { headers: { 'content-type': contentType } })
}

describe('browser HTTP rung response limits', () => {
  test('preserves small text responses and reports UTF-8 byte length', async () => {
    const content = 'Browser automation ✓'
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    )

    try {
      const result = await fetchHttpRung('https://example.test/small')
      expect(result.ok).toBe(true)
      expect(result.text).toBe(content)
      expect(result.bytes).toBe(Buffer.byteLength(content))
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('stops an undeclared oversized text response while streaming', async () => {
    let cancelled = false
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      oversizedResponse('text/plain', () => { cancelled = true }),
    )

    try {
      const result = await fetchHttpRung('https://example.test/large')
      expect(result.ok).toBe(false)
      expect(result.escalate).toBe(false)
      expect(result.bytes).toBe(MAX_BODY_BYTES)
      expect(result.error).toContain('too large to read')
      expect(cancelled).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('stops an undeclared oversized binary response while streaming', async () => {
    let cancelled = false
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      oversizedResponse('application/octet-stream', () => { cancelled = true }),
    )

    try {
      const result = await fetchHttpRung('https://example.test/large')
      expect(result.ok).toBe(false)
      expect(result.escalate).toBe(false)
      expect(result.bytes).toBe(MAX_BODY_BYTES)
      expect(result.error).toContain('too large to read')
      expect(cancelled).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
