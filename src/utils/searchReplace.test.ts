import { describe, expect, test } from 'bun:test'
import {
  applySearchReplace,
  applySearchReplaceBlocks,
  parseSearchReplace,
  SearchReplaceParseError,
  type SearchReplaceBlock,
} from './searchReplace.js'

function block(
  path: string,
  searchLines: string[],
  replaceLines: string[],
): SearchReplaceBlock {
  return { path, searchLines, replaceLines }
}

describe('parseSearchReplace', () => {
  test('parses a single fenced block with a filename', () => {
    const text = [
      'src/a.ts',
      '```typescript',
      '<<<<<<< SEARCH',
      'old',
      '=======',
      'new',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n')
    expect(parseSearchReplace(text)).toEqual([
      { path: 'src/a.ts', searchLines: ['old'], replaceLines: ['new'] },
    ])
  })

  test('inherits the filename from the previous block', () => {
    const text = [
      'src/a.ts',
      '<<<<<<< SEARCH',
      'one',
      '=======',
      'ONE',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'two',
      '=======',
      'TWO',
      '>>>>>>> REPLACE',
    ].join('\n')
    const blocks = parseSearchReplace(text)
    expect(blocks.map(b => b.path)).toEqual(['src/a.ts', 'src/a.ts'])
  })

  test('accepts ~~~ fences and cosmetic filename decoration', () => {
    const text = [
      '### `src/a.ts`:',
      '~~~python',
      '<<<<<<< SEARCH',
      'x = 1',
      '=======',
      'x = 2',
      '>>>>>>> REPLACE',
      '~~~',
    ].join('\n')
    expect(parseSearchReplace(text)[0]!.path).toBe('src/a.ts')
  })

  test('returns [] when there are no blocks', () => {
    expect(parseSearchReplace('just some prose')).toEqual([])
  })

  test('throws when a block has no filename to inherit', () => {
    const text = ['<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE'].join('\n')
    expect(() => parseSearchReplace(text)).toThrow(SearchReplaceParseError)
  })

  test('throws when the divider is missing', () => {
    const text = ['src/a.ts', '<<<<<<< SEARCH', 'a', '>>>>>>> REPLACE'].join('\n')
    expect(() => parseSearchReplace(text)).toThrow(/divider/)
  })

  test('throws when the REPLACE closer is missing', () => {
    const text = ['src/a.ts', '<<<<<<< SEARCH', 'a', '=======', 'b'].join('\n')
    expect(() => parseSearchReplace(text)).toThrow(/REPLACE/)
  })
})

describe('applySearchReplace — matching ladder', () => {
  test('exact match replaces line-for-line', () => {
    const original = 'a\nb\nc\n'
    expect(applySearchReplace(original, block('f', ['b'], ['B']))).toBe('a\nB\nc\n')
  })

  test('empty SEARCH creates a new file', () => {
    expect(applySearchReplace('', block('f', [], ['x', 'y']))).toBe('x\ny\n')
  })

  test('whitespace-flexible match re-indents the replacement', () => {
    const original = '  function f() {\n    return 1\n  }\n'
    // Model emitted the body with no indentation.
    const applied = applySearchReplace(
      original,
      block('f', ['return 1'], ['return 2']),
    )
    expect(applied).toBe('  function f() {\n    return 2\n  }\n')
  })

  test('ellipsis matches skipped content between segments', () => {
    const original = 'start\nmiddle one\nmiddle two\nend\n'
    const applied = applySearchReplace(
      original,
      block('f', ['start', '...', 'end'], ['START', '...', 'END']),
    )
    expect(applied).toBe('START\nmiddle one\nmiddle two\nEND\n')
  })

  test('fuzzy match tolerates small differences', () => {
    const original = 'one two three four five six seven eight nine ten\n'
    // One token differs out of ten → token-set ratio 9/11 ≈ 0.82 ≥ 0.8.
    const applied = applySearchReplace(
      original,
      block('f', ['one two three four five six seven eight nine TEN'], ['replaced']),
    )
    expect(applied).toBe('replaced\n')
  })

  test('throws when SEARCH cannot be located', () => {
    expect(() =>
      applySearchReplace('hello\n', block('f', ['nothing like this'], ['x'])),
    ).toThrow(/Could not find SEARCH content/)
  })
})

describe('applySearchReplaceBlocks', () => {
  test('folds multiple blocks across files, preserving order', () => {
    const files = { 'a.ts': 'one\n', 'b.ts': 'two\n' }
    const applied = applySearchReplaceBlocks(files, [
      block('a.ts', ['one'], ['1']),
      block('b.ts', ['two'], ['2']),
      block('a.ts', ['1'], ['ONE']),
    ])
    expect(applied).toEqual({ 'a.ts': 'ONE\n', 'b.ts': '2\n' })
  })
})
