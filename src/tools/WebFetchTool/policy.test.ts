import { describe, expect, test } from 'bun:test'
import {
  getWithPermittedRedirects,
  isPermittedRedirect,
  validateURL,
} from './utils.js'

describe('WebFetch request policy', () => {
  test('accepts public HTTP(S) URLs only', () => {
    expect(validateURL('https://example.com/docs')).toBe(true)
    expect(validateURL('http://example.com/docs')).toBe(true)
    expect(validateURL('file:///etc/passwd')).toBe(false)
    expect(validateURL('ftp://example.com/file')).toBe(false)
    expect(validateURL('https://user:pass@example.com/')).toBe(false)
  })

  test('rejects local and private network targets', () => {
    for (const url of [
      'http://localhost/',
      'http://service.local/',
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://172.20.0.1/',
      'http://192.168.1.1/',
      'http://192.0.2.1/',
      'http://198.18.0.1/',
      'http://169.254.169.254/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[2001:db8::1]/',
      'http://[2002:c000:0201::1]/',
      'http://[ff02::1]/',
    ]) {
      expect(validateURL(url)).toBe(false)
    }
  })

  test('follows only same-host redirects with the same scheme and port', () => {
    expect(
      isPermittedRedirect(
        'https://example.com/a',
        'https://www.example.com/b',
      ),
    ).toBe(true)
    expect(
      isPermittedRedirect('https://example.com/a', 'https://evil.test/b'),
    ).toBe(false)
    expect(
      isPermittedRedirect('https://example.com/a', 'http://example.com/b'),
    ).toBe(false)
    expect(
      isPermittedRedirect(
        'https://example.com:8443/a',
        'https://example.com/b',
      ),
    ).toBe(false)
  })

  test('propagates cancellation to the HTTP request', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | null = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal as AbortSignal
      return new Response('ok')
    }) as unknown as typeof fetch

    try {
      await getWithPermittedRedirects(
        'https://example.com/',
        controller.signal,
        () => false,
        0,
        'test-agent',
      )

      expect(requestSignal?.aborted).toBe(false)
      controller.abort()
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
