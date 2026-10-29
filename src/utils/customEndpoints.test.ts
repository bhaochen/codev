import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getCustomApiConfig,
  saveCustomApiConfig,
} from './auth.js'
import { getGlobalConfigSnapshot, normalizeCustomEndpoints } from './config.js'
import { getCustomEndpoints } from './model/providers.js'

// customEndpoints persisted by an older writer as a JSON string instead of
// an array — this is the shape that made /login crash with
// "s.findIndex is not a function".
const CORRUPT_STRING = JSON.stringify([
  {
    id: 'legacy-0',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: null,
    modelName: '',
  },
])

const CORRUPT_ENDPOINT = {
  id: 'legacy-0',
  baseUrl: 'http://127.0.0.1:8080/v1',
  apiKey: undefined,
  modelName: '',
}

const ENV_KEYS = [
  'CODEV_BASE_URL',
  'CODEV_API_KEY',
  'CODEV_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
] as const

/** Write a raw (possibly malformed) value into the shared in-memory test config. */
function setStoredEndpoints(value: unknown): void {
  ;(getGlobalConfigSnapshot() as unknown as Record<string, unknown>)
    .customEndpoints = value
}

describe('normalizeCustomEndpoints', () => {
  test('returns [] for nullish and non-array values', () => {
    expect(normalizeCustomEndpoints(undefined)).toEqual([])
    expect(normalizeCustomEndpoints(null)).toEqual([])
    expect(normalizeCustomEndpoints('')).toEqual([])
    expect(normalizeCustomEndpoints('not json')).toEqual([])
    expect(normalizeCustomEndpoints('{"baseUrl":"http://x/v1"}')).toEqual([])
    expect(normalizeCustomEndpoints({ baseUrl: 'http://x/v1' })).toEqual([])
  })

  test('parses a JSON-stringified endpoint array', () => {
    expect(normalizeCustomEndpoints(CORRUPT_STRING)).toEqual([CORRUPT_ENDPOINT])
  })

  test('drops malformed entries and synthesizes missing ids', () => {
    const normalized = normalizeCustomEndpoints([
      { baseUrl: 'http://a/v1' },
      null,
      'nope',
      { baseUrl: '' },
      { baseUrl: 42 },
      { id: 'ok', baseUrl: 'http://b/v1' },
    ])
    expect(normalized).toHaveLength(2)
    expect(typeof normalized[0].id).toBe('string')
    expect(normalized[0].id).not.toBe('')
    expect(normalized[0].baseUrl).toBe('http://a/v1')
    expect(normalized[1].id).toBe('ok')
    expect(normalized[1].baseUrl).toBe('http://b/v1')
  })

  test('preserves identity for an already canonical array', () => {
    const canonical = [
      { id: 'a', baseUrl: 'http://a/v1', apiKey: 'k', modelName: 'm' },
    ]
    expect(normalizeCustomEndpoints(canonical)).toBe(canonical)
  })
})

describe('reading a config whose customEndpoints is a string', () => {
  const originalEndpoints = getGlobalConfigSnapshot().customEndpoints

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
    setStoredEndpoints(CORRUPT_STRING)
  })

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
    setStoredEndpoints(originalEndpoints)
  })

  test('getCustomEndpoints parses instead of crashing', () => {
    expect(getCustomEndpoints()).toEqual([CORRUPT_ENDPOINT])
  })

  test('getCustomApiConfig resolves the active endpoint', () => {
    const config = getCustomApiConfig()
    expect(config.baseUrl).toBe('http://127.0.0.1:8080/v1')
    expect(config.modelName).toBe('')
  })

  test('saveCustomApiConfig repairs the stored value to an array', async () => {
    await saveCustomApiConfig(
      'http://127.0.0.1:8080/v1',
      'my-model',
      'sk-test',
    )
    const stored = getGlobalConfigSnapshot().customEndpoints
    expect(Array.isArray(stored)).toBe(true)
    expect(stored).toHaveLength(1)
    expect(stored?.[0]).toMatchObject({
      id: 'legacy-0',
      baseUrl: 'http://127.0.0.1:8080/v1',
      modelName: 'my-model',
      apiKey: 'sk-test',
    })
  })

  test('saveCustomApiConfig can add a second endpoint', async () => {
    await saveCustomApiConfig('http://127.0.0.1:20128/v1', 'router-model')
    const stored = getGlobalConfigSnapshot().customEndpoints
    expect(stored).toHaveLength(2)
    expect(stored?.[1].baseUrl).toBe('http://127.0.0.1:20128/v1')
  })
})
