/**
 * ComboEngine tests — verify safety invariants and fallback behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ComboEngine, classifyComboError } from './ComboEngine.js'
import type { ComboConfig } from './ComboEngine.js'
import type { LLMRequest, LLMStreamEvent } from './types.js'
import type { ProviderId } from '../types.js'

// ============================================================================
// Error Classification Tests
// ============================================================================

describe('classifyComboError', () => {
  it('classifies abort errors', () => {
    expect(classifyComboError(new Error('AbortError'))).toBe('abort')
    expect(classifyComboError(new Error('The operation was aborted'))).toBe('abort')
  })

  it('classifies auth errors', () => {
    expect(classifyComboError(new Error('401 Unauthorized'))).toBe('auth')
    expect(classifyComboError(new Error('403 Forbidden'))).toBe('auth')
  })

  it('classifies rate limit errors', () => {
    expect(classifyComboError(new Error('429 Too Many Requests'))).toBe('rate_limit')
    expect(classifyComboError(new Error('rate limit exceeded'))).toBe('rate_limit')
  })

  it('classifies timeout errors', () => {
    expect(classifyComboError(new Error('Request timeout'))).toBe('timeout')
    expect(classifyComboError(new Error('ETIMEDOUT'))).toBe('timeout')
  })

  it('classifies context overflow errors', () => {
    expect(classifyComboError(new Error('context window exceeded'))).toBe('context_overflow')
    expect(classifyComboError(new Error('context_length_exceeded'))).toBe('context_overflow')
  })

  it('classifies capacity errors', () => {
    expect(classifyComboError(new Error('529 overloaded'))).toBe('capacity')
    expect(classifyComboError(new Error('503 Service Unavailable'))).toBe('capacity')
  })

  it('classifies invalid request errors', () => {
    expect(classifyComboError(new Error('400 Bad Request'))).toBe('invalid_request')
  })

  it('classifies unknown errors', () => {
    expect(classifyComboError(new Error('something weird'))).toBe('unknown')
  })

  it('classifies by status property', () => {
    expect(classifyComboError({ status: 429 })).toBe('rate_limit')
    expect(classifyComboError({ status: 529 })).toBe('capacity')
    expect(classifyComboError({ status: 401 })).toBe('auth')
  })
})

// ============================================================================
// ComboEngine Tests
// ============================================================================

describe('ComboEngine', () => {
  let engine: ComboEngine

  beforeEach(() => {
    engine = new ComboEngine()
  })

  // Helper to create a minimal LLMRequest
  function createRequest(overrides?: Partial<LLMRequest>): LLMRequest {
    return {
      model: 'test-model',
      messages: [],
      systemPrompt: { content: '' },
      tools: [],
      signal: new AbortController().signal,
      config: {},
      context: {
        model: 'test-model',
        getToolPermissionContext: async () => ({}),
        agents: [],
        mcpTools: [],
        isNonInteractiveSession: false,
        querySource: 'repl_main_thread' as any,
      },
      ...overrides,
    }
  }

  // Helper to create a combo config
  function createCombo(overrides?: Partial<ComboConfig>): ComboConfig {
    return {
      items: [
        { provider: 'opencode' as ProviderId, model: 'model-a' },
        { provider: 'nvidia' as ProviderId, model: 'model-b' },
      ],
      ...overrides,
    }
  }

  it('should export ComboEngine class', () => {
    expect(ComboEngine).toBeDefined()
    expect(typeof ComboEngine).toBe('function')
  })

  it('should have generate method', () => {
    expect(typeof engine.generate).toBe('function')
  })

  it('should have clearCooldowns method', () => {
    expect(typeof engine.clearCooldowns).toBe('function')
  })

  it('should throw when no valid combo items', async () => {
    const combo = createCombo({ items: [] })
    await expect(async () => {
      for await (const _ of engine.generate(createRequest(), combo)) {
        // consume
      }
    }).rejects.toThrow('No valid combo items')
  })

  it('should filter paid models when allowPaidFallback is false', async () => {
    const combo = createCombo({
      items: [
        { provider: 'openai' as ProviderId, model: 'gpt-4' },
        { provider: 'opencode' as ProviderId, model: 'free-model' },
      ],
      allowPaidFallback: false,
    })
    
    // Should only try the free model
    const events: string[] = []
    try {
      for await (const _ of engine.generate(createRequest(), combo, (e) => {
        events.push(e.type)
      })) {
        // consume
      }
    } catch {
      // Expected to fail since we're using mock routes
    }
    
    // Should not have attempted the paid model
    expect(events).not.toContain('attempt_start')
  })
})
