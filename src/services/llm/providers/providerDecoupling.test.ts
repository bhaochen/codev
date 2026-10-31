import { describe, test, expect } from 'bun:test'
import { getProviderDef } from './index.js'
import { resolveRoute } from '../router/resolveRoute.js'
import { getClientForRoute } from '../clients/index.js'

describe('Provider ≠ Protocol', () => {
  test('openai provider defaults to the unified OpenAI-compatible protocol', () => {
    const def = getProviderDef('openai' as never) as { defaultProtocol: string; protocol: string }
    expect(def.defaultProtocol).toBe('openai-compatible-chat')
    expect(def.protocol).toBe('openai-compatible-chat') // alias preserved
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const rr = resolveRoute('gpt-5')
      expect(rr.provider).toBe('openai')
      expect(rr.protocol).toBe('openai-compatible-chat')
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })

  test('custom provider can use an explicit endpoint override', () => {
    const r = resolveRoute({ model: 'big-pickle', protocol: 'openai-compatible-chat', endpoint: 'https://example.com/v1' })
    expect(r.protocol).toBe('openai-compatible-chat')
    expect(r.endpoint).toBe('https://example.com/v1')
  })

  test('endpoint override independent of provider default', () => {
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const r = resolveRoute({ model: 'x', endpoint: 'https://custom.example.com/v1' })
      expect(r.endpoint).toBe('https://custom.example.com/v1')
      // protocol still default
      expect(r.protocol).toBe('openai-compatible-chat')
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })

  test('every resolved route uses the single registered client', () => {
    const r = resolveRoute({ model: 'x', endpoint: 'https://example.com/v1' })
    const c = getClientForRoute(r)
    expect(c).not.toBeNull()
  })
})
