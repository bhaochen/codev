import { describe, test, expect, beforeEach } from 'bun:test'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  getTrackingKey,
  recordPromptState,
  resetPromptCacheBreakDetection,
  __getTrackedKeysForTesting,
} from './promptCacheBreakDetection.js'

const MAIN_SYSTEM: TextBlockParam[] = [
  { type: 'text', text: 'You are Codev, chenbhao\u2019s CLI.' },
]
const SUMMARIZER_SYSTEM: TextBlockParam[] = [
  {
    type: 'text',
    text: 'You are a helpful AI assistant tasked with summarizing conversations.',
  },
]

describe('getTrackingKey', () => {
  test('compact is untracked so it cannot pollute repl_main_thread state', () => {
    expect(getTrackingKey('compact')).toBeNull()
  })

  test('main thread sources stay tracked', () => {
    expect(getTrackingKey('repl_main_thread')).toBe('repl_main_thread')
    expect(getTrackingKey('repl_main_thread:foo')).toBe('repl_main_thread:foo')
    expect(getTrackingKey('sdk')).toBe('sdk')
  })

  test('subagents are isolated by agentId', () => {
    expect(getTrackingKey('agent:custom', 'agent-1' as never)).toBe('agent-1')
    expect(getTrackingKey('agent:builtin', 'agent-2' as never)).toBe('agent-2')
  })

  test('untracked one-shot sources return null', () => {
    expect(getTrackingKey('session_memory')).toBeNull()
    expect(getTrackingKey('prompt_suggestion')).toBeNull()
  })
})

describe('recordPromptState', () => {
  beforeEach(() => {
    resetPromptCacheBreakDetection()
  })

  test('a compact fallback snapshot does not overwrite the main thread baseline', () => {
    recordPromptState({
      system: MAIN_SYSTEM,
      toolSchemas: [],
      querySource: 'repl_main_thread',
      model: 'claude-sonnet-4-5',
    })
    expect(__getTrackedKeysForTesting()).toContain('repl_main_thread')

    // Streaming fallback compact: different system prompt + tools.
    recordPromptState({
      system: SUMMARIZER_SYSTEM,
      toolSchemas: [],
      querySource: 'compact',
      model: 'claude-sonnet-4-5',
    })

    // Only the main thread key is tracked; compact created no snapshot and
    // left repl_main_thread's state intact.
    expect(__getTrackedKeysForTesting()).toEqual(['repl_main_thread'])
  })
})
