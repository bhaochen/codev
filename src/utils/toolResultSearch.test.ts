import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchToolResultFile, windowAround } from './toolResultSearch.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codev-trs-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, content: string | Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe('windowAround', () => {
  test('returns a fitting line unchanged', () => {
    expect(windowAround('short line', 0, 5, 400)).toBe('short line')
  })

  test('centres a long line on the hit and marks elisions', () => {
    const line = 'x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100)
    const out = windowAround(line, 100, 6, 30)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out).toContain('NEEDLE')
    // The window body is bounded; the two '…' markers sit outside it.
    expect(out.replace(/…/g, '').length).toBeLessThanOrEqual(30)
  })
})

describe('searchToolResultFile', () => {
  test('case-insensitive literal matches with line numbers', async () => {
    const path = await write(
      'log.txt',
      'alpha\nERROR: boom\nbeta\nerror: again\n',
    )
    const r = await searchToolResultFile(path, 'error')
    expect(r.matches).toBe(2)
    expect(r.completed).toBe(true)
    expect(r.content.split('\n')[0]).toBe('2: ERROR: boom')
    expect(r.content.split('\n')[1]).toBe('4: error: again')
    expect(r.scannedLines).toBe(4)
  })

  test('no match reports the full scan', async () => {
    const path = await write('empty.txt', 'a\nb\nc\n')
    const r = await searchToolResultFile(path, 'zzz')
    expect(r).toEqual({
      content: '',
      matches: 0,
      scannedLines: 3,
      completed: true,
      binary: false,
      truncated: false,
    })
  })

  test('the query is literal, not a regex', async () => {
    const path = await write('dots.txt', 'a.b\naxb\n')
    const r = await searchToolResultFile(path, '.')
    expect(r.matches).toBe(1)
    expect(r.content).toBe('1: a.b')
  })

  test('caps the number of matches', async () => {
    const path = await write(
      'many.txt',
      Array.from({ length: 10 }, (_, i) => `hit ${i}`).join('\n'),
    )
    const r = await searchToolResultFile(path, 'hit', { maxMatches: 3 })
    expect(r.matches).toBe(3)
    expect(r.truncated).toBe(true)
    expect(r.completed).toBe(false)
  })

  test('detects a binary payload and returns no content', async () => {
    const path = await write('bin.dat', Buffer.from('abc\u0000def\n'))
    const r = await searchToolResultFile(path, 'abc')
    expect(r.binary).toBe(true)
    expect(r.content).toBe('')
    expect(r.matches).toBe(0)
  })

  test('respects the byte budget', async () => {
    const path = await write(
      'big.txt',
      Array.from({ length: 50 }, () => 'match ' + 'x'.repeat(100)).join('\n'),
    )
    const r = await searchToolResultFile(path, 'match', { maxBytes: 100 })
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(100)
  })
})
