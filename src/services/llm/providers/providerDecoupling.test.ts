import { describe, test, expect } from 'bun:test'
import { getProviderDef } from './index.js'
import { resolveRoute } from '../router/resolveRoute.js'
import { getClientForRoute } from '../clients/index.js'

describe('Provider ≠ Protocol (Phase 9)', () => {
  test('provider defaultProtocol remains default (openai → openai-chat)', () => {
    const def = getProviderDef('openai' as never) as { defaultProtocol: string; protocol: string }
    expect(def.defaultProtocol).toBe('openai-chat')
    expect(def.protocol).toBe('openai-chat') // alias preserved
    const r = resolveRoute('gpt-5')
    // without override, uses default
    // need to set env to openai for deterministic provider
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const rr = resolveRoute('gpt-5')
      expect(rr.provider).toBe('openai')
      expect(rr.protocol).toBe('openai-chat')
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })

  test('same provider openai can use openai-responses', () => {
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const r = resolveRoute({ model: 'gpt-5', protocol: 'openai-responses' })
      expect(r.provider).toBe('openai')
      expect(r.protocol).toBe('openai-responses')
      const c = getClientForRoute(r)
      expect(c).not.toBeNull()
      // responses handler is different from chat
      const chat = getClientForRoute({ provider: 'openai' as never, protocol: 'openai-chat' as never, model: 'x', endpoint: 'y' })
      expect(c).not.toBe(chat)
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })

  test('same provider openai can use openai-compatible-chat', () => {
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const r = resolveRoute({ model: 'gpt-5', protocol: 'openai-compatible-chat', endpoint: 'https://custom.example.com/v1' })
      expect(r.provider).toBe('openai')
      expect(r.protocol).toBe('openai-compatible-chat')
      expect(r.endpoint).toBe('https://custom.example.com/v1')
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })

  test('provider defaultProtocol is only fallback, not exclusive', () => {
    // opencode default is openai-chat but can be overridden to compatible
    const def = getProviderDef('opencode' as never) as { defaultProtocol: string }
    expect(def.defaultProtocol).toBe('openai-chat')
    // even though default is chat, explicit compatible should work
    const r = resolveRoute({ model: 'big-pickle', protocol: 'openai-compatible-chat', endpoint: 'https://example.com/v1' })
    expect(r.protocol).toBe('openai-compatible-chat')
  })

  test('endpoint override independent of provider default', () => {
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const r = resolveRoute({ model: 'x', endpoint: 'https://custom.example.com/v1' })
      expect(r.endpoint).toBe('https://custom.example.com/v1')
      // protocol still default
      expect(r.protocol).toBe('openai-chat')
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })
})
