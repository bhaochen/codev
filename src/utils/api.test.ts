import { describe, expect, test } from 'bun:test'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type SystemPrompt,
} from '../constants/prompts.js'
import { splitSysPromptPrefix } from './api.js'

/**
 * Regression: the local llama.cpp provider previously reached
 * splitSysPromptPrefix with a non-string element inside the SystemPrompt
 * array. The block classifier in that function did `block.startsWith(...)`,
 * which crashed with
 * `l.startsWith is not a function. (In 'l.startsWith("x-anthropic-billing-header")',
 * 'l.startsWith' is undefined)`. buildSystemPromptBlocks and logAPIPrefix both
 * route through this single choke point, so the hardening must coerce any
 * non-string block instead of throwing.
 */
function asSystemPrompt(
  blocks: Array<
    string | number | boolean | null | undefined | { text?: string }
  >,
): SystemPrompt {
  return blocks as unknown as SystemPrompt
}

describe('splitSysPromptPrefix non-string hardening', () => {
  test('classifies a plain all-string prompt correctly', () => {
    const result = splitSysPromptPrefix(
      asSystemPrompt([
        'x-anthropic-billing-header: cc_workload=devtest',
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        '# Prefix section',
        '# Dynamic tail',
      ]),
    )
    const texts = result.map(block => block.text)
    expect(texts.join('\n\n')).toContain('x-anthropic-billing-header')
    expect(texts.join('\n\n')).toContain('# Prefix section')
    expect(texts.join('\n\n')).toContain('# Dynamic tail')
  })

  test('does not crash when a block is an object; preserves its body', () => {
    const result = splitSysPromptPrefix(
      asSystemPrompt(['# prefix', { text: '# object block' }, '# tail']),
    )
    const texts = result.map(block => block.text)
    expect(texts.join('\n\n')).toContain('# prefix')
    expect(texts.join('\n\n')).toContain('# object block')
    expect(texts.join('\n\n')).toContain('# tail')
  })

  test('coerces primitives and skips undefined/null without crashing', () => {
    const result = splitSysPromptPrefix(
      asSystemPrompt(['# prefix', 42, true, null, undefined, '# tail']),
    )
    const texts = result.map(block => block.text)
    expect(texts.join('\n\n')).toContain('# prefix')
    expect(texts.join('\n\n')).toContain('42')
    expect(texts.join('\n\n')).toContain('true')
    expect(texts.join('\n\n')).toContain('# tail')
  })

  test('returns an array (possibly empty) for garbage-only input', () => {
    const result = splitSysPromptPrefix(
      asSystemPrompt([null, undefined, {}, 1]),
    )
    expect(Array.isArray(result)).toBe(true)
  })
})
