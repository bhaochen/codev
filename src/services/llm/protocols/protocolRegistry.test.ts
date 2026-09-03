import { describe, test, expect } from 'bun:test'
import { ProtocolRegistry, getProtocolHandler, isProtocolSupported, getProtocolDef } from './index.js'
import { getClientForRoute } from '../clients/index.js'

describe('ProtocolRegistry runtime', () => {
  test('openai-chat resolves to queryOpenAIChat', () => {
    const def = getProtocolDef('openai-chat')
    expect(def).toBeDefined()
    expect(def!.handler).toBeDefined()
    expect(def!.handler!.name).toBe('queryOpenAIChat')
    expect(getProtocolHandler('openai-chat')).toBe(def!.handler)
    expect(isProtocolSupported('openai-chat')).toBe(true)
  })

  test('openai-responses resolves to queryOpenAIResponses', () => {
    const def = getProtocolDef('openai-responses')
    expect(def!.handler).toBeDefined()
    expect(def!.handler!.name).toBe('queryOpenAIResponses')
    expect(isProtocolSupported('openai-responses')).toBe(true)
  })

  test('openai-compatible-chat resolves to queryOpenAICompatibleChat', () => {
    const def = getProtocolDef('openai-compatible-chat')
    expect(def!.handler).toBeDefined()
    expect(def!.handler!.name).toBe('queryOpenAICompatibleChat')
    expect(isProtocolSupported('openai-compatible-chat')).toBe(true)
  })

  test('anthropic-messages resolves to queryAnthropicMessages', () => {
    const def = getProtocolDef('anthropic-messages')
    expect(def!.handler).toBeDefined()
    expect(def!.handler!.name).toBe('queryAnthropicMessages')
    expect(isProtocolSupported('anthropic-messages')).toBe(true)
  })

  test('gemini has no handler (unsupported)', () => {
    const def = getProtocolDef('gemini')
    expect(def).toBeDefined()
    expect(def!.handler).toBeUndefined()
    expect(isProtocolSupported('gemini')).toBe(false)
    expect(getProtocolHandler('gemini')).toBeUndefined()
    expect(getClientForRoute({ provider: 'openai' as never, protocol: 'gemini' as never, model: 'x' })).toBeNull()
  })

  test('bedrock-converse has no handler (unsupported)', () => {
    const def = getProtocolDef('bedrock-converse')
    expect(def).toBeDefined()
    expect(def!.handler).toBeUndefined()
    expect(isProtocolSupported('bedrock-converse')).toBe(false)
    expect(getClientForRoute({ provider: 'bedrock' as never, protocol: 'bedrock-converse' as never, model: 'x' })).toBeNull()
  })

  test('ProtocolRegistry is sole source of truth (clients facade)', () => {
    // clients/index should not have its own map; verify via registry
    expect(Object.keys(ProtocolRegistry).length).toBe(6)
    expect(ProtocolRegistry['openai-chat'].endpointPath).toBe('/chat/completions')
    expect(ProtocolRegistry['openai-responses'].endpointPath).toBe('/responses')
    expect(ProtocolRegistry['anthropic-messages'].endpointPath).toBe('/v1/messages')
  })
})
