/**
 * Model-native context window index (cross-provider adaptation).
 *
 * The api.json mirror carries every provider section; the same model body is
 * listed with different deployment caps. Native window = max across sections
 * for the same normalized base id — a deployment can shrink the model, never
 * exceed it.
 */
import { describe, expect, it } from 'bun:test'
import {
  deriveNativeWindows,
  normalizeModelBaseId,
} from './opencodeModels.js'

describe('normalizeModelBaseId', () => {
  it('strips org prefixes, channel variants, and free suffixes', () => {
    expect(normalizeModelBaseId('deepseek-v4.1-flash-free')).toBe(
      'deepseek-v4.1-flash',
    )
    expect(normalizeModelBaseId('deepseek-ai/deepseek-v4.1-flash')).toBe(
      'deepseek-v4.1-flash',
    )
    expect(normalizeModelBaseId('z-ai/glm-5.3-flash')).toBe('glm-5.3-flash')
    expect(normalizeModelBaseId('moonshotai/kimi-k3')).toBe('kimi-k3')
    expect(normalizeModelBaseId('meta-llama/llama-3.3-70b-instruct:free')).toBe(
      'llama-3.3-70b-instruct',
    )
    expect(normalizeModelBaseId('Big-Pickle')).toBe('big-pickle')
  })
})

describe('deriveNativeWindows', () => {
  const doc = {
    opencode: {
      models: {
        'deepseek-v4.1-flash-free': { limit: { context: 200_000, output: 32_000 } },
        'glm-5.3-flash-free': { limit: { context: 200_000, output: 32_000 } },
        'big-pickle': { limit: { context: 200_000, input: 160_000 } },
        'only-here': { limit: { context: 300_000 } },
      },
    },
    nvidia: {
      models: {
        'deepseek-ai/deepseek-v4.1-flash': { limit: { context: 1_000_000, output: 384_000 } },
        'big-pickle': { limit: { context: 900_000 } },
      },
    },
    openrouter: {
      models: {
        'some-org/glm-5.3-flash:free': { limit: { context: 500_000 } },
      },
    },
  }

  it('takes the max across sections for the same base model', () => {
    const index = deriveNativeWindows(doc)
    // free variant adopts the body's native 1M from the nvidia section.
    expect(index.get('deepseek-v4.1-flash')).toBe(1_000_000)
    // glm free variants match the paid opencode entry (500k vs 200k → max).
    expect(index.get('glm-5.3-flash')).toBe(500_000)
  })

  it('respects per-entry prompt ceilings before taking the max', () => {
    const index = deriveNativeWindows(doc)
    // big-pickle: opencode effective = min(200k, 160k) = 160k; nvidia 900k.
    expect(index.get('big-pickle')).toBe(900_000)
  })

  it('keeps models that only one section lists', () => {
    const index = deriveNativeWindows(doc)
    expect(index.get('only-here')).toBe(300_000)
  })

  it('ignores malformed entries and sections', () => {
    const index = deriveNativeWindows({
      broken: { models: { 'x': { nope: true } } },
      worse: { models: 'not-a-map' },
      empty: {},
    })
    expect(index.size).toBe(0)
  })
})
