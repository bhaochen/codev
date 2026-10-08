import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileReadTool } from './FileReadTool.js'
import type { ToolUseContext } from '../../Tool.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codev-readquery-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const context = {
  readFileState: new Map(),
  fileReadingLimits: undefined,
} as unknown as ToolUseContext

async function readQuery(file_path: string, query: string): Promise<string> {
  const out = (await FileReadTool.call(
    { file_path, query } as never,
    context,
  )) as unknown as { data: { type: string; file: { content: string } } }
  expect(out.data.type).toBe('text')
  return out.data.file.content
}

describe('FileReadTool query', () => {
  test('returns matching lines with numbers', async () => {
    const path = join(dir, 'log.txt')
    await writeFile(path, 'alpha\nERROR boom\nbeta\n')
    const content = await readQuery(path, 'error')
    expect(content).toContain('1 matching line')
    expect(content).toContain('2: ERROR boom')
  })

  test('reports a full-file scan on zero matches', async () => {
    const path = join(dir, 'none.txt')
    await writeFile(path, 'a\nb\n')
    const content = await readQuery(path, 'zzz')
    expect(content).toContain('No line contains "zzz"')
    expect(content).toContain('2 lines')
  })
})
