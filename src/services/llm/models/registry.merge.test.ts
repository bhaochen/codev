import { describe, test, expect, beforeEach } from 'bun:test'
import { getModel, hasModel, getModelMetadata, ModelRegistry, registerModelsDev, clearModelsDev } from './registry.js'

describe('ModelRegistry merge (Phase 12C)', () => {
  beforeEach(() => {
    clearModelsDev()
  })

  test('local only — big-pickle', () => {
    expect(hasModel('big-pickle')).toBe(true)
    expect(getModel('big-pickle')!.id).toBe('big-pickle')
    expect(ModelRegistry.has('big-pickle')).toBe(true)
  })

  test('models.dev only — register and lookup', () => {
    const res = registerModelsDev([{ id: 'openai/gpt-5', reasoning: true, tool_call: true, attachment: true, modalities: { input: ['text', 'image'] } }])
    expect(res.added).toBe(1)
    expect(hasModel('openai/gpt-5')).toBe(true)
    const m = getModel('openai/gpt-5')!
    expect(m.id).toBe('openai/gpt-5')
    expect(m.capabilities.reasoning).toBe(true)
    expect(m.capabilities.tools).toBe(true)
    expect(m.capabilities.vision).toBe(true)
  })

  test('local + models.dev — local overrides', () => {
    const res = registerModelsDev([{ id: 'big-pickle', reasoning: false, tool_call: false, attachment: false }])
    // big-pickle already in local, so skipped
    expect(res.added).toBe(0)
    expect(res.skipped).toBe(1)
    const m = getModel('big-pickle')!
    // still local definition (reasoning true)
    expect(m.capabilities.reasoning).toBe(true)
  })

  test('local overrides models.dev — different capabilities', () => {
    // first register a dev model with different id, then try to override local via dev
    registerModelsDev([{ id: 'openai/gpt-5', reasoning: false, tool_call: false }])
    expect(getModel('openai/gpt-5')!.capabilities.reasoning).toBe(false)
    // now try to register same id again with different caps — should be skipped (dedup)
    const res2 = registerModelsDev([{ id: 'openai/gpt-5', reasoning: true, tool_call: true }])
    expect(res2.added).toBe(0)
    expect(getModel('openai/gpt-5')!.capabilities.reasoning).toBe(false)
  })

  test('unknown model — has false, get undefined, getOrDefault returns default', () => {
    expect(hasModel('unknown/zzz')).toBe(false)
    expect(getModel('unknown/zzz')).toBeUndefined()
    expect(getModelMetadata('unknown/zzz').id).toBe('default')
    expect(ModelRegistry.get('unknown/zzz')).toBeUndefined()
    expect(ModelRegistry.getOrDefault('unknown/zzz').id).toBe('default')
  })

  test('has / get / getOrDefault / list', () => {
    registerModelsDev([{ id: 'deepseek/deepseek-v4-flash', reasoning: true, tool_call: true }])
    expect(hasModel('deepseek/deepseek-v4-flash')).toBe(true)
    expect(getModel('deepseek/deepseek-v4-flash')!.id).toBe('deepseek/deepseek-v4-flash')
    expect(getModelMetadata('deepseek/deepseek-v4-flash').id).toBe('deepseek/deepseek-v4-flash')
    const list = ModelRegistry.list()
    expect(list.some(m => m.id === 'big-pickle')).toBe(true)
    expect(list.some(m => m.id === 'deepseek/deepseek-v4-flash')).toBe(true)
    // list dedup: local + dev merged, no duplicate ids
    const ids = list.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('canonical id preserved provider/model', () => {
    registerModelsDev([{ id: 'anthropic/claude-opus-4-7', reasoning: true }])
    expect(getModel('anthropic/claude-opus-4-7')!.id).toBe('anthropic/claude-opus-4-7')
    // stripping would fail
    expect(getModel('claude-opus-4-7')).toBeUndefined()
  })

  test('same canonical id across providers — first wins, not per-provider', () => {
    // models.dev id includes provider, so same model served by multiple providers are different ids only if provider prefix differs
    // but if same id appears twice, second is skipped
    const r1 = registerModelsDev([{ id: 'openai/gpt-5', reasoning: false }])
    expect(r1.added).toBe(1)
    const r2 = registerModelsDev([{ id: 'openai/gpt-5', reasoning: true }])
    expect(r2.added).toBe(0)
  })

  test('invalid models.dev entries are skipped', () => {
    const res = registerModelsDev([{ reasoning: true } as never, { id: 'good/model', reasoning: true }])
    expect(res.added).toBe(1)
    expect(res.skipped).toBe(1)
    expect(hasModel('good/model')).toBe(true)
  })
})
