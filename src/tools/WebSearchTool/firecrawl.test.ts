import { afterEach, describe, expect, test } from 'bun:test'
import { WebSearchTool } from './WebSearchTool.js'
import { searchWithFirecrawl } from './firecrawl.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Firecrawl WebSearch backend', () => {
  test('sends bounded search requests and normalizes results', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input)
      requestInit = init
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                title: '  Example   result ',
                url: 'https://example.com/page',
                description: ' A useful snippet ',
                metadata: { image: 'https://example.com/image.png' },
              },
            ],
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const results = await searchWithFirecrawl('example query', {
      env: {
        FIRECRAWL_API_KEY: 'fc-test-key',
        FIRECRAWL_API_URL: 'https://firecrawl.test/',
      },
      allowedDomains: ['example.com'],
      blockedDomains: ['blocked.test'],
    })

    expect(requestUrl).toBe('https://firecrawl.test/v2/search')
    expect(requestInit?.method).toBe('POST')
    expect(new Headers(requestInit?.headers).get('authorization')).toBe(
      'Bearer fc-test-key',
    )
    const body = JSON.parse(String(requestInit?.body))
    expect(body).toMatchObject({
      query: 'example query',
      limit: 10,
      includeDomains: ['example.com'],
      excludeDomains: ['blocked.test'],
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    })
    expect(results).toEqual([
      {
        title: 'Example result',
        url: 'https://example.com/page',
        snippet: 'A useful snippet',
        image: 'https://example.com/image.png',
      },
    ])
  })

  test('fails clearly when the API key is missing', async () => {
    await expect(
      searchWithFirecrawl('query', { env: {} }),
    ).rejects.toThrow('FIRECRAWL_API_KEY is not configured')
  })

  test('surfaces Firecrawl HTTP errors without exposing credentials', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: false, error: 'invalid query' }), {
        status: 400,
      })) as unknown as typeof fetch

    await expect(
      searchWithFirecrawl('query', { env: { FIRECRAWL_API_KEY: 'fc-test-key' } }),
    ).rejects.toThrow('Firecrawl search failed: invalid query')
  })

  test('falls back from Firecrawl and enforces domain filters on fallback results', async () => {
    const oldFirecrawlKey = process.env.FIRECRAWL_API_KEY
    const oldFirecrawlUrl = process.env.FIRECRAWL_API_URL
    const oldTavilyKey = process.env.TAVILY_API_KEY
    const oldSearxUrl = process.env.SEARXNG_BASE_URL
    process.env.FIRECRAWL_API_KEY = 'fc-test-key'
    process.env.FIRECRAWL_API_URL = 'https://firecrawl.test'
    delete process.env.TAVILY_API_KEY
    process.env.SEARXNG_BASE_URL = 'https://searx.test'
    const requests: string[] = []
    globalThis.fetch = (async input => {
      const url =
        input instanceof Request ? input.url : String(input)
      requests.push(url)
      if (url.includes('firecrawl')) {
        return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
          status: 503,
        })
      }
      return new Response(
        JSON.stringify({
          results: [
            { title: 'Allowed', url: 'https://docs.example.com/page', content: 'keep' },
            { title: 'Spoofed suffix', url: 'https://example.com.evil.test/', content: 'drop' },
            { title: 'Blocked', url: 'https://blocked.example.com/', content: 'drop' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    try {
      const result = await WebSearchTool.call(
        {
          query: 'documentation',
          allowed_domains: ['example.com'],
          blocked_domains: ['blocked.example.com'],
        },
        {} as never,
        undefined,
        null,
      )

      expect(requests).toHaveLength(2)
      expect(requests[0]).toContain('/v2/search')
      expect(requests[1]).toContain('/search?')
      expect(result.data.results).toHaveLength(1)
      expect(
        typeof result.data.results[0] === 'string'
          ? result.data.results[0]
          : result.data.results[0]?.content[0]?.url,
      ).toBe('https://docs.example.com/page')
    } finally {
      if (oldFirecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY
      else process.env.FIRECRAWL_API_KEY = oldFirecrawlKey
      if (oldFirecrawlUrl === undefined) delete process.env.FIRECRAWL_API_URL
      else process.env.FIRECRAWL_API_URL = oldFirecrawlUrl
      if (oldTavilyKey === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = oldTavilyKey
      if (oldSearxUrl === undefined) delete process.env.SEARXNG_BASE_URL
      else process.env.SEARXNG_BASE_URL = oldSearxUrl
    }
  })
})
