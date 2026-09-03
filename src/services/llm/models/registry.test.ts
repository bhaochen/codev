import { describe, test, expect } from 'bun:test'
import { getModel, hasModel, getModelMetadata, ModelRegistry } from './registry.js'
import { resolveModel } from './modelResolver.js'
import { resolveRoute } from '../router/resolveRoute.js'

describe('ModelRegistry', () => {
  test('known model big-pickle', () => {
    const m = getModel('big-pickle')
    expect(m).toBeDefined()
    expect(m!.id).toBe('big-pickle')
    expect(m!.capabilities.tools).toBe(true)
    expect(hasModel('big-pickle')).toBe(true)
    expect(ModelRegistry.has('big-pickle')).toBe(true)
  })

  test('unknown model returns undefined for get, false for has', () => {
    expect(getModel('unknown-model-xyz')).toBeUndefined()
    expect(hasModel('unknown-model-xyz')).toBe(false)
    expect(ModelRegistry.get('unknown-model-xyz')).toBeUndefined()
  })

  test('getModelMetadata passthrough returns default for unknown', () => {
    const m = getModelMetadata('some-local-model')
    expect(m.id).toBe('default')
    expect(m.capabilities.streaming).toBe(true)
  })

  test('big-pickle via getModelMetadata preserves metadata', () => {
    const m = getModelMetadata('big-pickle')
    expect(m.id).toBe('big-pickle')
    expect(m.capabilities.reasoning).toBe(true)
  })

  test('resolver + registry separation: resolve then lookup', () => {
    const canonical = resolveModel('openai' as never, 'gpt-5')
    // registry lookup should not rewrite canonical
    const meta = getModel(canonical)
    // unknown canonical still passthrough, registry may be undefined, but route still uses canonical id
    if (meta) expect(meta.id).toBe(canonical)
    else expect(canonical).toBe('gpt-5') // passthrough
  })

  test('protocol independence: same model across protocols yields same registry', () => {
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const r1 = resolveRoute({ model: 'gpt-5', protocol: 'openai-chat' })
      const r2 = resolveRoute({ model: 'gpt-5', protocol: 'openai-responses' })
      expect(r1.model).toBe(r2.model)
      expect(getModel(r1.model)).toBe(getModel(r2.model))
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })

  test('provider independence: ModelRegistry not bound to provider', () => {
    // same model id should be lookup-able regardless of provider
    expect(getModel('big-pickle')!.id).toBe('big-pickle')
    // unknown local model still resolves via openai resolver but registry independent
    const m1 = resolveModel('openai' as never, 'gpt-5')
    const m2 = resolveModel('local' as never, 'gpt-5')
    expect(typeof m1).toBe('string')
    expect(typeof m2).toBe('string')
    // registry does not enforce provider
    expect(hasModel('big-pickle')).toBe(true)
  })

  test('list contains known models', () => {
    const list = ModelRegistry.list()
    expect(list.some(m => m.id === 'big-pickle')).toBe(true)
    expect(list.some(m => m.id === 'default')).toBe(true)
  })
})
