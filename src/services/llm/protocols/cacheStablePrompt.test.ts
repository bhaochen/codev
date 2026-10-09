import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetSessionVolatileFreezeForTest,
  applyCacheStableSystemPrompt,
  freezeSessionVolatileText,
  providerSplitsSystemPromptForCache,
  providerUsesOpenAIChatBoundary,
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

describe('volatile freeze isolation by lineage', () => {
  test('subagents do not share the main agent frozen tail', () => {
    const sys = (vol: string) => `rules\n${BOUNDARY}\n${vol}`
    const base = { lane: 'openrouter', model: 'm', sessionId: 's1' }
    const main = applyCacheStableSystemPrompt(
      [{ role: 'system', content: sys('git: clean') }],
      sys('git: clean'),
      { ...base, lineage: 'main' },
    )
    const agent = applyCacheStableSystemPrompt(
      [{ role: 'system', content: sys('git: dirty') }],
      sys('git: dirty'),
      { ...base, lineage: 'agent-1' },
    )
    // The agent keeps its own tail, not the main agent's frozen one.
    expect(JSON.stringify(main)).toContain('git: clean')
    expect(JSON.stringify(agent)).toContain('git: dirty')
    // Same lineage still replays its first frozen value.
    const mainAgain = applyCacheStableSystemPrompt(
      [{ role: 'system', content: sys('git: changed') }],
      sys('git: changed'),
      { ...base, lineage: 'main' },
    )
    expect(JSON.stringify(mainAgain)).toContain('git: clean')
    expect(JSON.stringify(mainAgain)).not.toContain('git: changed')
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

  test('the boundary is inserted for providers whose wire handles it', () => {
    expect(providerUsesOpenAIChatBoundary('opencode')).toBe(true)
    expect(providerUsesOpenAIChatBoundary('nvidia')).toBe(true)
    expect(providerUsesOpenAIChatBoundary('openai')).toBe(true)
    // firstParty/bedrock/vertex/foundry use their own cache-scope handling.
    expect(providerUsesOpenAIChatBoundary('firstParty')).toBe(false)
    expect(providerUsesOpenAIChatBoundary(null)).toBe(false)
  })

  test('only implicit-cache providers split', () => {
    expect(providerSplitsSystemPromptForCache('deepseek', 'x')).toBe(true)
    expect(providerSplitsSystemPromptForCache('opencode', 'deepseek-ai/deepseek-v4.1-flash')).toBe(true)
    expect(providerSplitsSystemPromptForCache('openrouter', 'acme/model')).toBe(true)
    expect(providerSplitsSystemPromptForCache('openai', 'gpt-5.4')).toBe(false)
  })
})
