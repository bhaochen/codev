import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { readFileInRange } from './readFileInRange.js'

describe('readFileInRange byte truncation', () => {
  test('returns a complete-line prefix when truncate mode is enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codev-read-range-'))
    const filePath = join(directory, 'large.ts')
    try {
      await writeFile(filePath, Array(30).fill('a').join('\n'))
      const result = await readFileInRange(
        filePath,
        0,
        undefined,
        8,
        undefined,
        { truncateOnByteLimit: true },
      )

      expect(result.content).toBe('a\na\na\na')
      expect(result.truncatedByBytes).toBe(true)
      expect(result.totalLines).toBe(30)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
