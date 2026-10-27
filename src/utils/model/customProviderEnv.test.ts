import { describe, test, expect, afterEach } from 'bun:test'
import {
  getAPIProvider,
  getCodevEnvBaseUrl,
  getCustomBaseUrl,
  getCustomModelName,
  getEnvCustomBaseUrl,
  isCustomConfigured,
} from './providers.js'
import { getCustomApiConfig } from '../auth.js'

const ENV_KEYS = [
  'CODEV_BASE_URL',
  'CODEV_API_KEY',
  'CODEV_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('custom provider env overrides', () => {
  test('no env → no custom endpoint', () => {
    expect(getEnvCustomBaseUrl()).toBeUndefined()
    expect(getCodevEnvBaseUrl()).toBeUndefined()
    expect(getCustomBaseUrl()).toBeUndefined()
  })

  test('CODEV_BASE_URL selects the custom provider', () => {
    process.env.CODEV_BASE_URL = 'http://gw:9090/sessions/eval-0/v1'
    expect(getCustomBaseUrl()).toBe('http://gw:9090/sessions/eval-0/v1')
    expect(isCustomConfigured()).toBe(true)
    expect(getAPIProvider()).toBe('custom')
  })

  test('OPENAI_BASE_URL is the generic fallback', () => {
    process.env.OPENAI_BASE_URL = 'http://gw:9090/v1'
    expect(getCustomBaseUrl()).toBe('http://gw:9090/v1')
    expect(isCustomConfigured()).toBe(true)
    expect(getAPIProvider()).toBe('custom')
  })

  test('CODEV_BASE_URL wins over OPENAI_BASE_URL', () => {
    process.env.CODEV_BASE_URL = 'http://codev:1/v1'
    process.env.OPENAI_BASE_URL = 'http://openai:2/v1'
    expect(getCustomBaseUrl()).toBe('http://codev:1/v1')
  })

  test('api key and model come from the env when nothing is stored', () => {
    process.env.CODEV_BASE_URL = 'http://gw:9090/v1'
    process.env.CODEV_API_KEY = 'sk-env'
    process.env.CODEV_MODEL = 'gpt-4o'
    const config = getCustomApiConfig()
    expect(config.baseUrl).toBe('http://gw:9090/v1')
    expect(config.apiKey).toBe('sk-env')
    expect(config.modelName).toBe('gpt-4o')
    expect(getCustomModelName()).toBe('gpt-4o')
  })

  test('generic OPENAI_* env is used when CODEV_* is absent', () => {
    process.env.OPENAI_BASE_URL = 'http://gw:9090/v1'
    process.env.OPENAI_API_KEY = 'sk-openai'
    process.env.OPENAI_MODEL = 'gpt-5'
    const config = getCustomApiConfig()
    expect(config.baseUrl).toBe('http://gw:9090/v1')
    expect(config.apiKey).toBe('sk-openai')
    expect(config.modelName).toBe('gpt-5')
  })
})
