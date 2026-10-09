import { describe, expect, test } from 'bun:test'
import { requestWithRetry } from './retryHttpRequest.js'

const OPTS = { maxAttempts: 3, baseDelayMs: 1 }

describe('requestWithRetry network classification', () => {
  test('does not retry a programmer TypeError (no cause)', async () => {
    let calls = 0
    const request = async (): Promise<Response> => {
      calls++
      throw new TypeError('Failed to parse URL from x')
    }
    await expect(requestWithRetry(request, undefined, OPTS)).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('retries a fetch TypeError carrying an errno cause', async () => {
    let calls = 0
    const request = async (): Promise<Response> => {
      calls++
      const error = new TypeError('fetch failed')
      ;(error as { cause?: unknown }).cause = Object.assign(new Error('reset'), {
        code: 'ECONNRESET',
      })
      throw error
    }
    await expect(requestWithRetry(request, undefined, OPTS)).rejects.toThrow()
    expect(calls).toBe(3)
  })

  test('retries a retryable HTTP status before the body is consumed', async () => {
    let calls = 0
    const request = async (): Promise<Response> => {
      calls++
      if (calls === 1) return new Response('busy', { status: 503 })
      return new Response('ok', { status: 200 })
    }
    const response = await requestWithRetry(request, undefined, OPTS)
    expect(response.status).toBe(200)
    expect(calls).toBe(2)
  })
})
