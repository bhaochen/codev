/**
 * Agent-scoped provider pinning.
 *
 * These pin the two properties that make the AsyncLocalStorage safe to put in
 * front of getAPIProvider(): a pinned scope sees its provider, and nothing
 * outside the scope does.
 */
import { describe, expect, test } from 'bun:test'
import {
  canApplyAgentProvider,
  getForcedProvider,
  runWithAgentProvider,
  runWithForcedProvider,
} from './forcedProvider.js'
import { getAPIProvider } from './model/providers.js'

describe('forced provider', () => {
  test('pins the provider for the async scope only', () => {
    const outside = getAPIProvider()
    expect(getForcedProvider()).toBeUndefined()
    runWithForcedProvider({ provider: 'nvidia' }, () => {
      expect(getForcedProvider()).toBe('nvidia')
      expect(getAPIProvider()).toBe('nvidia')
    })
    expect(getForcedProvider()).toBeUndefined()
    expect(getAPIProvider()).toBe(outside)
  })

  test('an agent-scoped pin is replaceable by a more specific nested agent', () => {
    runWithAgentProvider('nvidia', () => {
      expect(getAPIProvider()).toBe('nvidia')
      expect(canApplyAgentProvider('openai')).toBe(true)
      runWithAgentProvider('openai', () => {
        expect(getAPIProvider()).toBe('openai')
      })
      expect(getAPIProvider()).toBe('nvidia')
    })
  })

  test('an undefined provider applies nothing', () => {
    const outside = getAPIProvider()
    runWithAgentProvider(undefined, () => {
      expect(getForcedProvider()).toBeUndefined()
      expect(getAPIProvider()).toBe(outside)
    })
  })

  test('an explicit pin beats an agent pin', () => {
    runWithForcedProvider({ provider: 'opencode' }, () => {
      expect(canApplyAgentProvider('nvidia')).toBe(false)
      runWithAgentProvider('nvidia', () => {
        expect(getAPIProvider()).toBe('opencode')
      })
    })
    expect(getForcedProvider()).toBeUndefined()
  })

  test('nesting restores the outer agent pin on the way out', () => {
    runWithAgentProvider('opencode', () => {
      runWithAgentProvider('nvidia', () => {
        expect(getAPIProvider()).toBe('nvidia')
      })
      expect(getAPIProvider()).toBe('opencode')
    })
    expect(getForcedProvider()).toBeUndefined()
  })
})
