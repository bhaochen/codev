import { describe, expect, test } from 'bun:test'
import { buildGroupedGrepSummary, parseGrepContentLine } from './groupFlood.js'

function lines(spec: Array<[file: string, count: number]>): string[] {
  return spec.flatMap(([file, count]) =>
    Array.from({ length: count }, (_, index) => `${file}:${index + 1}: match`),
  )
}

describe('grouped grep summaries', () => {
  test('parses POSIX and Windows paths without splitting the drive letter', () => {
    expect(parseGrepContentLine('src/a.ts:42: foo')).toEqual({
      path: 'src/a.ts',
      lineNumber: 42,
    })
    expect(parseGrepContentLine('C:\\repo\\a.ts:7: foo')).toEqual({
      path: 'C:\\repo\\a.ts',
      lineNumber: 7,
    })
    expect(parseGrepContentLine('src/a.ts:no line number')).toBeNull()
  })

  test('leaves small and marginal results flat', () => {
    expect(buildGroupedGrepSummary(lines([['a.ts', 10]]), 250, path => path)).toBeNull()
    expect(
      buildGroupedGrepSummary(lines([['a.ts', 130], ['b.ts', 130]]), 250, path => path),
    ).toBeNull()
  })

  test('summarizes real floods across files, sorted by count with anchors', () => {
    const result = buildGroupedGrepSummary(
      lines([['small.ts', 20], ['big.ts', 300], ['mid.ts', 120]]),
      250,
      path => path,
    )
    expect(result?.numLines).toBe(440)
    expect(result?.numFiles).toBe(3)
    expect(result?.content.indexOf('big.ts — 300 matches')).toBeLessThan(
      result!.content.indexOf('mid.ts — 120 matches'),
    )
    expect(result?.content).toContain('lines 1, 2, 3')
  })

  test('summarizes a moderate overflow spread across many files', () => {
    const result = buildGroupedGrepSummary(
      lines(Array.from({ length: 6 }, (_, index) => [`${index}.ts`, 50])),
      250,
      path => path,
    )
    expect(result?.numFiles).toBe(6)
  })

  test('caps anchors and the listed file count with honest omitted totals', () => {
    const manyFiles = Array.from({ length: 60 }, (_, index) => [`file${index}.ts`, 10] as [string, number])
    const result = buildGroupedGrepSummary(lines(manyFiles), 250, path => path)
    expect(result?.content).toContain('… and 20 more files (200 matches)')

    const anchors = buildGroupedGrepSummary(
      lines([['big.ts', 400], ['a.ts', 2], ['b.ts', 2], ['c.ts', 2]]),
      250,
      path => path,
    )
    expect(anchors?.content).toContain(', …')
  })

  test('falls back for mostly unparseable output and remains deterministic', () => {
    expect(
      buildGroupedGrepSummary(
        Array.from({ length: 400 }, (_, index) => `unparseable ${index}`),
        250,
        path => path,
      ),
    ).toBeNull()
    const input = lines([['b.ts', 300], ['a.ts', 150]])
    expect(buildGroupedGrepSummary(input, 250, path => path)?.content).toBe(
      buildGroupedGrepSummary(input, 250, path => path)?.content,
    )
  })
})
