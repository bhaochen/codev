import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetSessionVolatileFreezeForTest,
  applyCacheStableSystemPrompt,
  freezeSessionVolatileText,
  providerSplitsSystemPromptForCache,
  splitSystemPromptForCache,
  stripSystemDynamicBoundary,
} from './cacheStablePrompt.js'
import type { OpenAIChatMessage } from './openaiChatWire.js'

const BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

beforeEach(() => {
  _resetSessionVolatileFreezeForTest()
})

describe('splitSystemPromptForCache', () => {
  test('splits on the explicit boundary marker', () => {
    const text = `stable rules\n\n${BOUNDARY}\n\ngitStatus: dirty`
    expect(splitSystemPromptForCache(text)).toEqual({
      stable: 'stable rules',
      volatile: 'gitStatus: dirty',
    })
  })

  test('falls back to the first volatile section after 30%', () => {
    const text = `${'stable '.repeat(20)}\n# Environment\nOS: linux`
    const { stable, volatile } = splitSystemPromptForCache(text)
    expect(stable).not.toContain('# Environment')
    expect(volatile).toContain('# Environment')
  })

  test('a prompt without volatile sections stays whole', () => {
    expect(splitSystemPromptForCache('just rules')).toEqual({
      stable: 'just rules',
      volatile: '',
    })
  })

  test('strip removes the marker for providers that do not split', () => {
    expect(stripSystemDynamicBoundary(`a\n\n${BOUNDARY}\n\nb`)).toBe('a\n\nb')
  })
})

describe('frozen volatile context', () => {
  test('the first non-empty value is pinned for the session', () => {
    expect(freezeSessionVolatileText('k', '')).toBe('')
    expect(freezeSessionVolatileText('k', 'gitStatus: clean')).toBe('gitStatus: clean')
    // A later MCP connect must not rewrite an already-sent prefix.
    expect(freezeSessionVolatileText('k', 'gitStatus: dirty')).toBe('gitStatus: clean')
  })

  test('the block sits at a fixed leading position after the system message', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: `rules\n${BOUNDARY}\ngitStatus: clean` },
      { role: 'user', content: 'hi' },
    ]
    const out = applyCacheStableSystemPrompt(messages, `rules\n${BOUNDARY}\ngitStatus: clean`, {
      lane: 'deepseek',
      model: 'deepseek-v4.1-flash',
      sessionId: 's1',
    })
    expect(out[0]).toEqual({ role: 'system', content: 'rules' })
    expect(out[1]).toEqual({
      role: 'user',
      content: '<dynamic_context>\ngitStatus: clean\n</dynamic_context>',
    })
    expect(out[2]).toEqual({ role: 'user', content: 'hi' })

    // Second turn: same frozen block, same position (pure prefix extension).
    const again = applyCacheStableSystemPrompt(
      [
        { role: 'system', content: `rules\n${BOUNDARY}\ngitStatus: dirty now` },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      `rules\n${BOUNDARY}\ngitStatus: dirty now`,
      { lane: 'deepseek', model: 'deepseek-v4.1-flash', sessionId: 's1' },
    )
    expect(again[1]).toEqual({
      role: 'user',
      content: '<dynamic_context>\ngitStatus: clean\n</dynamic_context>',
    })
  })

  test('only implicit-cache providers split', () => {
    expect(providerSplitsSystemPromptForCache('deepseek', 'x')).toBe(true)
    expect(providerSplitsSystemPromptForCache('opencode', 'deepseek-ai/deepseek-v4.1-flash')).toBe(true)
    expect(providerSplitsSystemPromptForCache('openrouter', 'acme/model')).toBe(true)
    expect(providerSplitsSystemPromptForCache('openai', 'gpt-5.4')).toBe(false)
  })
})
