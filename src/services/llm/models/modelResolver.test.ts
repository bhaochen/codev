import { describe, test, expect } from 'bun:test'
import { resolveModel, getModelResolver } from './modelResolver.js'
import { resolveRoute } from '../router/resolveRoute.js'

describe('ModelResolver independent', () => {
  test('passthrough for firstParty', () => {
    expect(resolveModel('firstParty' as never, 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(getModelResolver('firstParty' as never).id).toBe('passthrough')
  })

  test('openai resolver via resolveOpenAIModel', () => {
    // resolveOpenAIModel may map, but at least returns a string and is via openai resolver
    expect(getModelResolver('openai' as never).id).toBe('openai')
    const m = resolveModel('openai' as never, 'gpt-5')
    expect(typeof m).toBe('string')
    expect(m.length).toBeGreaterThan(0)
  })

  test('opencode resolver fallback', () => {
    expect(getModelResolver('opencode' as never).id).toBe('opencode')
    const m = resolveModel('opencode' as never, 'test-model')
    // without config, should return test-model or big-pickle fallback
    expect(typeof m).toBe('string')
  })

  test('resolveRoute normal model gpt-5', () => {
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const r = resolveRoute('gpt-5')
      expect(r.provider).toBe('openai')
      expect(r.model).toBe(resolveModel('openai' as never, 'gpt-5'))
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })

  test('explicit model + protocol does not rewrite model', () => {
    const prev = process.env.CLAUDE_CODE_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openai'
    try {
      const r = resolveRoute({ model: 'gpt-5', protocol: 'openai-responses' })
      expect(r.provider).toBe('openai')
      expect(r.model).toBe(resolveModel('openai' as never, 'gpt-5'))
      expect(r.protocol).toBe('openai-responses')
    } finally {
      if (prev === undefined) delete (process.env as never)['CLAUDE_CODE_API_PROVIDER']
      else process.env.CLAUDE_CODE_API_PROVIDER = prev
    }
  })

  test('different providers keep their own resolution', () => {
    expect(resolveModel('bedrock' as never, 'anthropic.claude')).toBe('anthropic.claude')
    expect(resolveModel('local' as never, 'my-local')).toBe('my-local')
  })
})
