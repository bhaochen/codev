import { describe, test, expect } from 'bun:test'
import { findReplBlocks, truncateOutput } from '../parsing.js'

describe('findReplBlocks', () => {
  test('extracts repl-fenced blocks', () => {
    const text = [
      'Let me try something.',
      '```repl',
      'x = 42',
      'print(x)',
      '```',
      'And now:',
      '```repl',
      'y = x + 1',
      'print(y)',
      '```',
    ].join('\n')
    expect(findReplBlocks(text)).toEqual(['x = 42\nprint(x)', 'y = x + 1\nprint(y)'])
  })

  test('falls back to python/py fences when no repl fence', () => {
    const text = 'Here is code:\n```python\nprint("hi")\n```\nDone.'
    expect(findReplBlocks(text)).toEqual(['print("hi")'])
  })

  test('falls back to untagged fences', () => {
    const text = '```\nprint("raw")\n```'
    expect(findReplBlocks(text)).toEqual(['print("raw")'])
  })

  test('ignores non-python tags like json/text', () => {
    const text = '```json\n{"a":1}\n```\n```text\nhello\n```'
    expect(findReplBlocks(text)).toEqual([])
  })

  test('ignores python fence when repl fence exists', () => {
    const text = '```repl\nprint("r")\n```\n```python\nprint("p")\n```'
    expect(findReplBlocks(text)).toEqual(['print("r")'])
  })

  test('repl blocks win even with extra spaces around tag', () => {
    const text = '```  repl  \nprint("ok")\n```'
    expect(findReplBlocks(text)).toEqual(['print("ok")'])
  })

  test('empty response returns empty', () => {
    expect(findReplBlocks('')).toEqual([])
    expect(findReplBlocks('no code here')).toEqual([])
  })

  test('strips trailing whitespace from block', () => {
    const text = '```repl\nprint("x")  \n   \n```'
    expect(findReplBlocks(text)).toEqual(['print("x")'])
  })
})

describe('truncateOutput', () => {
  test('short text returned as-is', () => {
    expect(truncateOutput('hello', 100)).toBe('hello')
  })

  test('long text is head/tail elided', () => {
    const long = 'a'.repeat(1000)
    const result = truncateOutput(long, 100, 'X')
    expect(result.length).toBeLessThan(long.length)
    expect(result).toContain('... [')
    expect(result).toContain('X] ...')
    expect(result.startsWith('aaaa')).toBe(true)
    expect(result.endsWith('aaaa')).toBe(true)
  })
})
