import { describe, expect, test } from 'bun:test'
import {
  applyGeminiOpenRouterCacheAnchor,
  isGeminiOnOpenRouter,
  pickGeminiOpenRouterAnchorIndex,
  type StampableMessage,
} from './openrouterGeminiCache.js'
import { applyCacheStableSystemPrompt } from './cacheStablePrompt.js'
import type { OpenAIChatMessage } from './openaiChatWire.js'

// Head size for the fixtures below: system 'sys' (3) + volatile 'frozen' (6).
const HEAD = 9

function msg(
  role: OpenAIChatMessage['role'],
  content: string,
  extra?: Record<string, unknown>,
): StampableMessage {
  return { role, content, ...extra }
}

function volatileMsg(text = 'frozen'): StampableMessage {
  // Reuse the production marker: split a prompt so the frozen <dynamic_context>
  // message is created (and tracked) exactly as it is at request time, then
  // shrink its content to keep the fixture arithmetic exact.
  const context = applyCacheStableSystemPrompt(
    [{ role: 'system', content: 'sys' }],
    `head__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__${text}`,
    { lane: 't', model: 'm', sessionId: `vol:${text}` },
  )[1]!
  ;(context as { content: string }).content = text
  return context as StampableMessage
}

function stamps(messages: StampableMessage[]): number[] {
  const out: number[] = []
  messages.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some(p => p.cache_control)) out.push(i)
  })
  return out
}

describe('isGeminiOnOpenRouter', () => {
  test('recognizes Gemini ids only', () => {
    expect(isGeminiOnOpenRouter('google/gemini-2.5-flash')).toBe(true)
    expect(isGeminiOnOpenRouter('gemini-2.0-pro')).toBe(true)
    expect(isGeminiOnOpenRouter('anthropic/claude-sonnet-4.5')).toBe(false)
    expect(isGeminiOnOpenRouter('deepseek/deepseek-chat')).toBe(false)
  })
})

describe('pickGeminiOpenRouterAnchorIndex', () => {
  test('bare first turn anchors the fresh user tail', () => {
    const messages = [msg('system', 'sys'), msg('user', 'hi')]
    expect(pickGeminiOpenRouterAnchorIndex(messages, 16_000)).toBe(1)
  })

  test('turn 1 with a volatile head anchors the volatile message', () => {
    const messages = [msg('system', 'sys'), volatileMsg(), msg('user', 'hi')]
    expect(pickGeminiOpenRouterAnchorIndex(messages, 16_000)).toBe(1)
  })

  test('anchor holds while settled growth stays under a quantum', () => {
    const messages = [
      msg('system', 'sys'),
      volatileMsg(),
      msg('assistant', 'a'.repeat(5_000), { tool_calls: [] }),
      msg('user', 'tail'),
    ]
    expect(pickGeminiOpenRouterAnchorIndex(messages, 16_000)).toBe(1)
  })

  test('anchor advances by quanta as settled growth crosses them', () => {
    const messages = [
      msg('system', 'sys'),
      volatileMsg(),
      msg('assistant', 'a'.repeat(8_000)),
      msg('assistant', 'b'.repeat(4_000)),
      msg('user', 'tail'),
    ]
    // head 9; target = head + 1·8000 = 8009 → lands exactly on the first
    // assistant (cum 8009), not yet the second (12009).
    expect(pickGeminiOpenRouterAnchorIndex(messages, 8_000)).toBe(2)
  })

  test('trailing user/tool messages are never the anchor', () => {
    const messages = [
      msg('system', 'sys'),
      volatileMsg(),
      msg('assistant', 'a'.repeat(8_000)),
      msg('user', 'question'),
      msg('tool', 'x'.repeat(20_000), { tool_call_id: 't1' }),
    ]
    const pick = pickGeminiOpenRouterAnchorIndex(messages, 4_000)
    // The huge in-flight tool result must not pull the anchor forward.
    expect(pick).toBe(2)
    expect(messages[pick]!.role).toBe('assistant')
  })
})

describe('applyGeminiOpenRouterCacheAnchor', () => {
  test('stamps exactly one message and promotes string content to parts', () => {
    const messages: StampableMessage[] = [
      msg('system', 'sys'),
      volatileMsg(),
      msg('user', 'hi'),
    ]
    applyGeminiOpenRouterCacheAnchor(messages as unknown as OpenAIChatMessage[])
    expect(stamps(messages)).toEqual([1])
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: 'frozen', cache_control: { type: 'ephemeral' } },
    ])
  })

  test('strips stale breakpoints left on other messages', () => {
    const messages: StampableMessage[] = [
      msg('system', 'sys'),
      volatileMsg(),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'old', cache_control: { type: 'ephemeral' } },
        ],
      },
      msg('user', 'tail'),
    ]
    applyGeminiOpenRouterCacheAnchor(messages as unknown as OpenAIChatMessage[])
    expect(stamps(messages)).toEqual([1])
  })

  test('walks toward the head when the pick has no stampable text', () => {
    const toolCalls = [
      { id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } },
    ]
    const messages: StampableMessage[] = [
      msg('system', 'sys'),
      volatileMsg(),
      // Only tool_calls, no text part to stamp.
      msg('assistant', '', { tool_calls: toolCalls }),
      msg('user', 'tail'),
    ]
    // Quantum = the settled growth, so the target lands on the tool-only
    // assistant (cum = head + growth) before it has to walk back.
    const growth = JSON.stringify(toolCalls).length
    expect(pickGeminiOpenRouterAnchorIndex(messages, growth)).toBe(2)
    applyGeminiOpenRouterCacheAnchor(messages as unknown as OpenAIChatMessage[])
    expect(stamps(messages)).toEqual([1])
  })

  test('anchoring can be disabled by env', () => {
    process.env.OPENROUTER_GEMINI_ANCHOR = 'off'
    try {
      const messages: StampableMessage[] = [msg('system', 'sys'), volatileMsg(), msg('user', 'hi')]
      applyGeminiOpenRouterCacheAnchor(messages as unknown as OpenAIChatMessage[])
      expect(stamps(messages)).toEqual([])
    } finally {
      delete process.env.OPENROUTER_GEMINI_ANCHOR
    }
  })

  test('quantum env override is honored', () => {
    process.env.OPENROUTER_GEMINI_QUANTUM = '4000'
    try {
      const messages: StampableMessage[] = [
        msg('system', 'sys'),
        volatileMsg(),
        msg('assistant', 'a'.repeat(4_000)),
        msg('assistant', 'b'.repeat(4_000)),
        msg('user', 'tail'),
      ]
      applyGeminiOpenRouterCacheAnchor(messages as unknown as OpenAIChatMessage[])
      expect(stamps(messages)).toEqual([3])
    } finally {
      delete process.env.OPENROUTER_GEMINI_QUANTUM
    }
  })
})

test('HEAD constant matches the fixture head size', () => {
  expect(3 + 'frozen'.length).toBe(HEAD)
})
