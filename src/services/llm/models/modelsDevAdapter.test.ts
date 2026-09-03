import { describe, test, expect } from 'bun:test'
import { fromModelsDev } from './modelsDevAdapter.js'

describe('fromModelsDev', () => {
  test('plain text model', () => {
    const m = fromModelsDev({ id: 'openai/gpt-4o', reasoning: false, tool_call: false, attachment: false, modalities: { input: ['text'], output: ['text'] } })
    expect(m.id).toBe('openai/gpt-4o')
    expect(m.capabilities.reasoning).toBe(false)
    expect(m.capabilities.tools).toBe(false)
    expect(m.capabilities.vision).toBe(false)
    expect(m.capabilities.streaming).toBe(true)
  })

  test('reasoning model', () => {
    const m = fromModelsDev({ id: 'openai/gpt-5', reasoning: true, tool_call: false })
    expect(m.capabilities.reasoning).toBe(true)
  })

  test('tool_call model', () => {
    const m = fromModelsDev({ id: 'anthropic/claude-opus-4-7', tool_call: true })
    expect(m.capabilities.tools).toBe(true)
  })

  test('vision with image', () => {
    const m = fromModelsDev({ id: 'openai/gpt-5', attachment: true, modalities: { input: ['text', 'image'] } })
    expect(m.capabilities.vision).toBe(true)
  })

  test('vision with pdf', () => {
    const m = fromModelsDev({ id: 'anthropic/claude-opus-4-7', attachment: true, modalities: { input: ['text', 'pdf'] } })
    expect(m.capabilities.vision).toBe(true)
  })

  test('vision false when attachment false', () => {
    const m = fromModelsDev({ id: 'x/y', attachment: false, modalities: { input: ['text', 'image'] } })
    expect(m.capabilities.vision).toBe(false)
  })

  test('vision false when modalities missing image/pdf', () => {
    const m = fromModelsDev({ id: 'x/y', attachment: true, modalities: { input: ['text'] } })
    expect(m.capabilities.vision).toBe(false)
  })

  test('missing optional fields defaults to false', () => {
    const m = fromModelsDev({ id: 'test/model' })
    expect(m.capabilities.reasoning).toBe(false)
    expect(m.capabilities.tools).toBe(false)
    expect(m.capabilities.vision).toBe(false)
    expect(m.capabilities.streaming).toBe(true)
  })

  test('missing modalities defaults to vision false', () => {
    const m = fromModelsDev({ id: 'test/model', attachment: true })
    expect(m.capabilities.vision).toBe(false)
  })

  test('missing id throws', () => {
    expect(() => fromModelsDev({} as never)).toThrow('missing id')
    expect(() => fromModelsDev({ id: '' } as never)).toThrow('missing id')
    expect(() => fromModelsDev({ id: '   ' } as never)).toThrow('missing id')
    expect(() => fromModelsDev(null as never)).toThrow('expected object')
  })

  test('id preserved provider/model', () => {
    const m = fromModelsDev({ id: 'openai/gpt-5' })
    expect(m.id).toBe('openai/gpt-5')
    const m2 = fromModelsDev({ id: 'deepseek/deepseek-v4-flash' })
    expect(m2.id).toBe('deepseek/deepseek-v4-flash')
  })

  test('trims id', () => {
    const m = fromModelsDev({ id: '  openai/gpt-5  ' })
    expect(m.id).toBe('openai/gpt-5')
  })
})
