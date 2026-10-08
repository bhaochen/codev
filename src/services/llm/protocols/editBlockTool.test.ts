import { describe, expect, test } from 'bun:test'
import { preferredEditFormat } from './editFormat.js'
import {
  adaptEditBlockToolUse,
  applyPreferredEditFormat,
  EDIT_BLOCK_TOOL_NAME,
} from './editBlockTool.js'

describe('preferredEditFormat', () => {
  test('coder-tuned models choose edit_block', () => {
    expect(preferredEditFormat('deepseek-coder-v2')).toBe('edit_block')
    expect(preferredEditFormat('deepseek/deepseek-coder')).toBe('edit_block')
    expect(preferredEditFormat('moonshotai/kimi-k2')).toBe('edit_block')
    expect(preferredEditFormat('qwen3-coder-30b')).toBe('edit_block')
    expect(preferredEditFormat('llama-3.3-70b')).toBe('edit_block')
    expect(preferredEditFormat('grok-code-fast-1')).toBe('edit_block')
  })

  test('everything else keeps the native edit tool', () => {
    expect(preferredEditFormat('gpt-4o')).toBe('str_replace')
    expect(preferredEditFormat('claude-sonnet-4.5')).toBe('str_replace')
    expect(preferredEditFormat('llama-3.1-8b')).toBe('str_replace')
  })
})

describe('applyPreferredEditFormat', () => {
  const tools = [{ name: 'Bash' }, { name: 'Edit' }, { name: 'Read' }]

  test('swaps Edit for edit_block in place for coder models', () => {
    const out = applyPreferredEditFormat(tools, 'deepseek-coder-v2')
    expect(out.map(t => t.name)).toEqual(['Bash', EDIT_BLOCK_TOOL_NAME, 'Read'])
  })

  test('leaves the list untouched for other models', () => {
    const out = applyPreferredEditFormat(tools, 'gpt-4o')
    expect(out).toBe(tools)
  })

  test('is a no-op when Edit is absent', () => {
    const noEdit = [{ name: 'Bash' }, { name: 'Read' }]
    expect(applyPreferredEditFormat(noEdit, 'deepseek-coder')).toBe(noEdit)
  })
})

describe('adaptEditBlockToolUse', () => {
  test('maps a JSON-string body to an Edit tool_use', () => {
    const adapted = adaptEditBlockToolUse({
      name: EDIT_BLOCK_TOOL_NAME,
      input: JSON.stringify({ path: 'a.ts', search: 'old', replace: 'new' }),
    })
    expect(adapted).toEqual({
      name: 'Edit',
      input: { file_path: 'a.ts', old_string: 'old', new_string: 'new' },
    })
  })

  test('maps an object body too', () => {
    expect(
      adaptEditBlockToolUse({
        name: EDIT_BLOCK_TOOL_NAME,
        input: { path: 'b.ts', search: 'x', replace: 'y' },
      }),
    ).toEqual({
      name: 'Edit',
      input: { file_path: 'b.ts', old_string: 'x', new_string: 'y' },
    })
  })

  test('ignores other tools and malformed bodies', () => {
    expect(adaptEditBlockToolUse({ name: 'Edit', input: {} })).toBeNull()
    expect(
      adaptEditBlockToolUse({ name: EDIT_BLOCK_TOOL_NAME, input: 'not json' }),
    ).toBeNull()
    expect(
      adaptEditBlockToolUse({
        name: EDIT_BLOCK_TOOL_NAME,
        input: { path: 'a.ts' },
      }),
    ).toBeNull()
  })
})
