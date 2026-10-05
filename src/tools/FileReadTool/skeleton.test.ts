import { describe, expect, test } from 'bun:test'
import {
  buildSkeleton,
  fileReadTokenLimitAdvice,
  isSkeletonSupportedExt,
} from './skeleton.js'

const formatRun = (content: string, startLine: number) =>
  content
    .split('\n')
    .map((line, index) => `${String(index + startLine).padStart(4)} ${line}`)
    .join('\n')

const longTypeScript = [
  'import { readFile } from "fs"',
  '',
  'export function longFunction(): number {',
  ...Array.from({ length: 8 }, (_, index) => `  const value${index} = ${index}`),
  '  return 42',
  '}',
  '',
  'export const short = () => 1',
].join('\n')

describe('code skeleton reads', () => {
  test('supports source extensions and excludes prose/data files', () => {
    expect(isSkeletonSupportedExt('ts')).toBe(true)
    expect(isSkeletonSupportedExt('py')).toBe(true)
    expect(isSkeletonSupportedExt('md')).toBe(false)
    expect(isSkeletonSupportedExt('json')).toBe(false)
  })

  test('elides long bodies while keeping declarations and real line-number ranges', async () => {
    const result = await buildSkeleton(longTypeScript, 'ts', formatRun)
    expect(result).not.toBeNull()
    expect(result!.formatted).toContain('export function longFunction')
    expect(result!.formatted).not.toContain('const value0')
    expect(result!.formatted).toContain('export const short')
    expect(result!.formatted).toContain('lines 4-12 (9 lines)')
    expect(result!.elidedRegions).toBe(1)
    expect(result!.elidedLines).toBe(9)
    expect(result!.formatted).toContain('  13 }')
  })

  test('leaves small bodies intact and falls back to ordinary reads', async () => {
    const result = await buildSkeleton(
      'function a() { return 1 }\nfunction b() { return 2 }',
      'ts',
      formatRun,
    )
    expect(result).toBeNull()
    expect(await buildSkeleton(longTypeScript, 'md', formatRun)).toBeNull()
  })

  test('truncates overlong kept lines and accounts for omitted characters', async () => {
    const source = `${longTypeScript}\n// ${'x'.repeat(2000)}`
    const result = await buildSkeleton(source, 'ts', formatRun)
    expect(result?.truncatedLines).toBe(1)
    expect(result?.truncatedChars).toBe(1503)
    expect(result?.formatted).toContain('[+1503 chars elided from this line]')
  })

  test('offers a skeleton retry only for supported files not already requested', () => {
    expect(fileReadTokenLimitAdvice('ts', false)).toContain('skeleton: true')
    expect(fileReadTokenLimitAdvice('ts', true)).not.toContain('skeleton: true')
    expect(fileReadTokenLimitAdvice('md', false)).not.toContain('skeleton: true')
  })
})
