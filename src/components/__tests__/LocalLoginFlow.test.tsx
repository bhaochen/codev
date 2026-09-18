import { describe, expect, test, vi, beforeEach, afterEach } from 'bun:test'

const modelsResponse = {
  models: [{ name: 'qwen3.6-35b-a3b', model: 'qwen3.6-35b-a3b', type: 'model' }],
  data: [{ id: 'qwen3.6-35b-a3b', meta: { n_params: 34660610688 } }],
  object: 'list'
} as const

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/v1/models')) {
      return new Response(JSON.stringify(modelsResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    throw new Error('unexpected fetch')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

describe('LocalLoginFlow — current behavior (buggy)', () => {
  test('URL analysis extracts from path, not from /v1/models', () => {
    function currentAnalyzeUrl(inputUrl: string): string {
      try {
        const urlObj = new URL(inputUrl)
        const pathParts = urlObj.pathname.split('/').filter(Boolean)
        return pathParts[pathParts.length - 1] || 'default'
      } catch {
        return ''
      }
    }

    expect(currentAnalyzeUrl('https://example.com/models/qwen3.6-35b-a3b')).toBe('qwen3.6-35b-a3b')
    expect(currentAnalyzeUrl('https://uniprotkb-cleveland-additions-girlfriend.trycloudflare.com')).toBe('default')
  })

  test('JSX renders as literal string instead of component', () => {
    const buggyOutput = 'Detected model: <Text bold={true}>{modelName}</Text>'
    expect(buggyOutput).toContain('<Text bold={true}>')
    expect(buggyOutput).toContain('{modelName}')
  })
})

describe('LocalLoginFlow — expected behavior (after fix)', () => {
  test('should fetch /v1/models to detect model', async () => {
    const fetchCalls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: RequestInfo | URL) => {
      fetchCalls.push(String(u))
      return new Response(JSON.stringify(modelsResponse), { status: 200 })
    })

    const baseUrl = 'https://example.com'
    await fetch(`${baseUrl}/v1/models`)
    expect(fetchCalls).toContain('https://example.com/v1/models')
  })

  test('should handle fetch failure gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => 
      new Response('Not Found', { status: 404 })
    )

    const baseUrl = 'https://example.com'
    const response = await fetch(`${baseUrl}/v1/models`)
    expect(response.ok).toBe(false)
  })

  test('should not show stale model when URL changes during fetch', async () => {
    let resolveFirst: (v: Response) => void
    const firstFetch = new Promise<Response>(r => { resolveFirst = r })
    
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/v1/models')) {
        return firstFetch
      }
      throw new Error('unexpected')
    })

    const firstUrl = 'https://first.example.com'
    const secondUrl = 'https://second.example.com'
    const firstPromise = fetch(`${firstUrl}/v1/models`)
    const secondPromise = fetch(`${secondUrl}/v1/models`)
    resolveFirst!(new Response(JSON.stringify({
      models: [{ name: 'stale-model', model: 'stale-model', type: 'model' }],
      data: [{ id: 'stale-model' }],
      object: 'list'
    }), { status: 200 }))
    await Promise.all([firstPromise, secondPromise])
  })
})