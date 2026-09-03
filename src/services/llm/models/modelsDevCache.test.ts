import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearModelsDev, hasModel, getModel } from './registry.js'
import { loadModelsDevCache, fetchAndCacheModelsDev, syncModelsDevCache } from './modelsDevCache.js'

function fakeFetch(data: Record<string, unknown>) {
  return async () => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }) as unknown as typeof fetch
}

describe('modelsDevCache', () => {
  let dir: string
  let cachePath: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codev-test-'))
    cachePath = join(dir, 'models.json')
    clearModelsDev()
  })
  afterEach(async () => {
    clearModelsDev()
    await rm(dir, { recursive: true, force: true })
  })

  test('fetchAndCache writes file and registers', async () => {
    const data = { 'openai/gpt-5': { id: 'openai/gpt-5', reasoning: true, tool_call: true, attachment: true, modalities: { input: ['text', 'image'] } } }
    const res = await fetchAndCacheModelsDev({ fetchFn: fakeFetch(data) as never, cachePath })
    expect(res.fetched).toBe(1)
    expect(res.added).toBe(1)
    expect(hasModel('openai/gpt-5')).toBe(true)
    const raw = await readFile(cachePath, 'utf8')
    expect(JSON.parse(raw)).toEqual(data)
  })

  test('loadCache hit when fresh', async () => {
    const data = { 'openai/gpt-5': { id: 'openai/gpt-5', reasoning: true } }
    await fetchAndCacheModelsDev({ fetchFn: fakeFetch(data) as never, cachePath })
    clearModelsDev()
    const res = await loadModelsDevCache({ cachePath, ttlMs: 24 * 60 * 60 * 1000 })
    expect(res.hit).toBe(true)
    expect(res.added).toBe(1)
    expect(hasModel('openai/gpt-5')).toBe(true)
  })

  test('loadCache miss when stale (TTL expired)', async () => {
    const data = { 'openai/gpt-5': { id: 'openai/gpt-5', reasoning: true } }
    await fetchAndCacheModelsDev({ fetchFn: fakeFetch(data) as never, cachePath })
    clearModelsDev()
    // make file stale by setting mtime to past
    const { utimes } = await import('fs/promises')
    const past = new Date(Date.now() - 100_000)
    await utimes(cachePath, past, past)
    const res = await loadModelsDevCache({ cachePath, ttlMs: 1 })
    expect(res.hit).toBe(false)
    expect(hasModel('openai/gpt-5')).toBe(false)
  })

  test('offline fetch failure does not crash, keeps cache', async () => {
    const data = { 'openai/gpt-5': { id: 'openai/gpt-5', reasoning: true } }
    await fetchAndCacheModelsDev({ fetchFn: fakeFetch(data) as never, cachePath })
    clearModelsDev()
    const { utimes } = await import('fs/promises')
    const past = new Date(Date.now() - 100_000)
    await utimes(cachePath, past, past)
    const failingFetch = async () => { throw new Error('offline') }
    const res = await syncModelsDevCache({ fetchFn: failingFetch as never, cachePath, ttlMs: 1 })
    expect(res.cacheHit).toBe(false)
  })

  test('corrupted cache is skipped', async () => {
    const { writeFile } = await import('fs/promises')
    await writeFile(cachePath, 'not-json', 'utf8')
    const res = await loadModelsDevCache({ cachePath })
    expect(res.hit).toBe(false)
    expect(res.added).toBe(0)
  })

  test('catalog.json shape (models field) also handled', async () => {
    const catalog = { models: { 'openai/gpt-5': { id: 'openai/gpt-5', reasoning: true } } }
    const res = await fetchAndCacheModelsDev({ fetchFn: fakeFetch(catalog as never) as never, cachePath })
    expect(res.fetched).toBe(1)
    expect(hasModel('openai/gpt-5')).toBe(true)
  })
})
