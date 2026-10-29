import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getGlobalConfigSnapshot } from '../config.js'
import {
  fetchCustomModels,
  getCachedCustomModels,
  resetCustomModelsForTests,
} from './customModels.js'
import { getModelOptions } from './modelOptions.js'
import { getModelsUrl } from './providers.js'

function setStoredEndpoints(value: unknown): void {
  ;(getGlobalConfigSnapshot() as unknown as Record<string, unknown>)
    .customEndpoints = value
}

const originalEndpoints = getGlobalConfigSnapshot().customEndpoints

const MODEL_PAYLOAD = {
  data: [
    {
      id: 'Spark-X2.6-4B-Q4_K_M.gguf',
      aliases: ['Spark-X2.6-4B-Q4_K_M.gguf'],
      object: 'model',
      meta: { n_ctx: 120064 },
    },
    {
      id: 'no-metadata-model',
      object: 'model',
    },
  ],
}

describe('getModelsUrl', () => {
  test('does not duplicate /v1 for bases that already end in /v1', () => {
    expect(getModelsUrl('http://127.0.0.1:8080/v1')).toBe(
      'http://127.0.0.1:8080/v1/models',
    )
    expect(getModelsUrl('http://127.0.0.1:8080/v1/')).toBe(
      'http://127.0.0.1:8080/v1/models',
    )
  })

  test('appends /v1 for bare bases', () => {
    expect(getModelsUrl('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/v1/models',
    )
  })

  test('preserves path prefixes', () => {
    expect(getModelsUrl('https://host/api/v1')).toBe(
      'https://host/api/v1/models',
    )
    expect(getModelsUrl('https://host/proxy')).toBe(
      'https://host/proxy/v1/models',
    )
  })
})

describe('custom endpoint models', () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  let baseUrl = ''

  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === '/v1/models') {
          return Response.json(MODEL_PAYLOAD)
        }
        return new Response('not found', { status: 404 })
      },
    })
    baseUrl = `http://127.0.0.1:${server.port}/v1`
    setStoredEndpoints([{ id: 'ep-1', baseUrl }])
  })

  afterEach(() => {
    server?.stop(true)
    server = undefined
    setStoredEndpoints(originalEndpoints)
  })

  afterAll(async () => {
    await fetchCustomModels([])
  })

  test('fetches every model, including ones without context metadata', async () => {
    const models = await fetchCustomModels([{ id: 'ep-1', baseUrl }])
    expect(models.map(m => m.id).sort()).toEqual([
      'Spark-X2.6-4B-Q4_K_M.gguf',
      'no-metadata-model',
    ])
    expect(
      models.find(m => m.id === 'Spark-X2.6-4B-Q4_K_M.gguf')?.contextWindow,
    ).toBe(120064)
    expect(
      models.find(m => m.id === 'no-metadata-model')?.contextWindow,
    ).toBeUndefined()
  })

  test('/model options expose the fetched custom models', async () => {
    await fetchCustomModels([{ id: 'ep-1', baseUrl }])
    expect(getCachedCustomModels().length).toBe(2)

    const options = getModelOptions(false)
    const custom = options.find(o => o.value === 'Spark-X2.6-4B-Q4_K_M.gguf')
    expect(custom).toBeDefined()
    expect(custom?.label).toBe('Spark-X2.6-4B-Q4_K_M.gguf')
    expect(custom?.description).toContain(baseUrl)
    expect(options.some(o => o.value === 'no-metadata-model')).toBe(true)
  })

  test('/model shows no hard-coded default when nothing is available', () => {
    setStoredEndpoints([
      { id: 'ep-empty', baseUrl: 'http://127.0.0.1:1/v1' },
    ])
    resetCustomModelsForTests()
    // No models cached yet: the picker must not fall back to a hard-coded
    // "Default (recommended)" (value: null) entry.
    expect(getModelOptions(false).some(o => o.value === null)).toBe(false)
  })
})
