import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { getAuthStrategy, resolveAuth, authHeadersForRoute, authStrategyId } from './resolveAuth.js'
import { createBearerStrategy, createApiKeyStrategy, noneStrategy, credentialToHeaders } from './strategies.js'

describe('AuthStrategy', () => {
  test('bearer strategy returns Bearer token when present', () => {
    const s = createBearerStrategy(() => 'tok123')
    const cred = s.resolve('openai' as never)
    expect(cred).toEqual({ type: 'bearer', token: 'tok123' })
    expect(credentialToHeaders(cred)).toEqual({ Authorization: 'Bearer tok123' })
  })

  test('bearer strategy fallback token (opencode public)', () => {
    const s = createBearerStrategy(() => null, { fallbackToken: 'public' })
    const cred = s.resolve('opencode' as never)
    expect(cred).toEqual({ type: 'bearer', token: 'public' })
  })

  test('bearer strategy returns none when no token and no fallback', () => {
    const s = createBearerStrategy(() => null)
    const cred = s.resolve('openai' as never)
    expect(cred).toEqual({ type: 'none' })
    expect(credentialToHeaders(cred)).toEqual({})
  })

  test('api-key strategy returns x-api-key header', () => {
    const s = createApiKeyStrategy(() => 'ak123', 'x-api-key')
    expect(s.id).toBe('api-key')
    const cred = s.resolve('firstParty' as never)
    expect(cred).toEqual({ type: 'api-key', key: 'ak123', headerName: 'x-api-key' })
    expect(credentialToHeaders(cred)).toEqual({ 'x-api-key': 'ak123' })
  })

  test('none strategy always none', () => {
    expect(noneStrategy.id).toBe('none')
    expect(noneStrategy.resolve('firstParty' as never)).toEqual({ type: 'none' })
  })

  test('custom provider uses the bearer strategy; others fall back to none', () => {
    // Unified runtime: only the custom endpoint carries its own API key.
    // The 9router gateway (openai) is handled upstream — requests use the
    // public fallback token, so its strategy resolves to none here.
    expect(authStrategyId('custom' as never)).toBe('bearer')
    expect(authStrategyId('openai' as never)).toBe('none')
  })

  test('firstParty/bedrock share none strategy', () => {
    expect(authStrategyId('firstParty' as never)).toBe('none')
    expect(authStrategyId('bedrock' as never)).toBe('none')
    expect(getAuthStrategy('firstParty' as never)).toBe(getAuthStrategy('bedrock' as never))
  })

  test('openrouter (legacy pin) resolves to none — no per-provider credentials', () => {
    expect(getAuthStrategy('openrouter' as never).id).toBe('none')
  })

  test('resolveAuth delegates to strategy', () => {
    const cred = resolveAuth('openai' as never)
    // without env, should be none (no OPENAI_API_KEY)
    expect(cred.type).toBe('none')
  })

  test('authHeadersForRoute returns headers for route', () => {
    const headers = authHeadersForRoute({ provider: 'firstParty' as never, protocol: 'anthropic-messages' as never, model: 'x' })
    expect(headers).toEqual({})
  })
})
