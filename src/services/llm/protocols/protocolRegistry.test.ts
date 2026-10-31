import { describe, test, expect } from 'bun:test'
import { ProtocolRegistry, getProtocolHandler, isProtocolSupported, getProtocolDef } from './index.js'
import { getClientForRoute } from '../clients/index.js'

describe('ProtocolRegistry runtime', () => {
  test('openai-compatible-chat resolves to queryOpenAICompatibleChat', () => {
    const def = getProtocolDef('openai-compatible-chat')
    expect(def).toBeDefined()
    expect(def!.handler).toBeDefined()
    expect(def!.handler!.name).toBe('queryOpenAICompatibleChat')
    expect(getProtocolHandler('openai-compatible-chat')).toBe(def!.handler)
    expect(isProtocolSupported('openai-compatible-chat')).toBe(true)
  })

  test('unified registry carries only the OpenAI-compatible protocol', () => {
    expect(Object.keys(ProtocolRegistry)).toEqual(['openai-compatible-chat'])
    expect(ProtocolRegistry['openai-compatible-chat'].endpointPath).toBe('/chat/completions')
  })

  test('legacy protocols have no handler and resolve to a null client', () => {
    for (const legacy of ['openai-chat', 'openai-responses', 'anthropic-messages', 'aws-eventstream', 'gemini', 'bedrock-converse'] as const) {
      expect(getProtocolDef(legacy as never)).toBeUndefined()
      expect(isProtocolSupported(legacy as never)).toBe(false)
      expect(getProtocolHandler(legacy as never)).toBeUndefined()
      expect(getClientForRoute({ provider: 'openai' as never, protocol: legacy as never, model: 'x' })).toBeNull()
    }
  })

  test('ProtocolRegistry is sole source of truth (clients facade)', () => {
    expect(Object.keys(ProtocolRegistry).length).toBe(1)
    const client = getClientForRoute({ provider: 'openai' as const, protocol: 'openai-compatible-chat' as const, model: 'x', endpoint: 'y' })
    expect(client).not.toBeNull()
  })
})
