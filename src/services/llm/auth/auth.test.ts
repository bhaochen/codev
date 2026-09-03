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

  test('different providers can share same strategy id (bearer reuse)', () => {
    expect(authStrategyId('openai' as never)).toBe('bearer')
    expect(authStrategyId('opencode' as never)).toBe('bearer')
    expect(authStrategyId('nvidia' as never)).toBe('bearer')
    // same id, different token sources but same strategy type
    expect(getAuthStrategy('openai' as never).id).toBe(getAuthStrategy('opencode' as never).id)
  })

  test('firstParty/bedrock share none strategy', () => {
    expect(authStrategyId('firstParty' as never)).toBe('none')
    expect(authStrategyId('bedrock' as never)).toBe('none')
    expect(getAuthStrategy('firstParty' as never)).toBe(getAuthStrategy('bedrock' as never))
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
