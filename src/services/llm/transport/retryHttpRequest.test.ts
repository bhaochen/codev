import { describe, expect, test } from 'bun:test'
import { requestWithRetry } from './retryHttpRequest.js'

describe('requestWithRetry', () => {
  test('retries transient server responses then returns the successful response', async () => {
    const statuses = [503, 502, 200]
    let requests = 0

    const response = await requestWithRetry(
      async () => new Response(null, { status: statuses[requests++]! }),
      undefined,
      { baseDelayMs: 0 },
    )

    expect(response.status).toBe(200)
    expect(requests).toBe(3)
  })

  test('retries the same request and honors a bounded Retry-After header', async () => {
    const request = {
      url: 'https://example.test/chat/completions',
      body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
    }
    const seenRequests: typeof request[] = []
    let requests = 0
    const response = await requestWithRetry(
      async () => {
        seenRequests.push(request)
        requests++
        return requests === 1
          ? new Response(null, { status: 429, headers: { 'retry-after': '0' } })
          : new Response(null, { status: 200 })
      },
      undefined,
      { baseDelayMs: 0 },
    )

    expect(response.status).toBe(200)
    expect(seenRequests).toEqual([request, request])
  })

  test('retries network errors but does not retry non-retryable client errors', async () => {
    let requests = 0
    const response = await requestWithRetry(
      async () => {
        requests++
        if (requests === 1) throw new TypeError('fetch failed')
        return new Response(null, { status: 400 })
      },
      undefined,
      { baseDelayMs: 0 },
    )

    expect(response.status).toBe(400)
    expect(requests).toBe(2)
  })

  test('does not retry aborts or retryable statuses after the attempt budget', async () => {
    const controller = new AbortController()
    controller.abort()
    let requests = 0

    await expect(
      requestWithRetry(
        async () => {
          requests++
          return new Response(null, { status: 503 })
        },
        controller.signal,
        { baseDelayMs: 0 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toBe(0)

    const response = await requestWithRetry(
      async () => {
        requests++
        return new Response(null, { status: 503 })
      },
      undefined,
      { maxAttempts: 2, baseDelayMs: 0 },
    )
    expect(response.status).toBe(503)
    expect(requests).toBe(2)
  })
})
