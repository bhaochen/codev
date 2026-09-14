import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSource } from '../resolve.js'

let sharedDir: string

beforeAll(async () => {
  sharedDir = await mkdtemp(join(tmpdir(), 'rlm-resolve-test-'))
  await mkdir(join(sharedDir, 'sub'), { recursive: true })
  await writeFile(join(sharedDir, 'a.txt'), 'hello world')
  await writeFile(join(sharedDir, 'sub', 'deep.ts'), 'export const x = 1')
  await writeFile(join(sharedDir, '.env'), 'SECRET=abc')
  await writeFile(join(sharedDir, 'empty.txt'), '')
})

afterAll(async () => {
  await rm(sharedDir, { recursive: true, force: true })
})

describe('resolveSource', () => {
  test('single file → one entry with file content', async () => {
    const r = await resolveSource(join(sharedDir, 'a.txt'), { cwd: sharedDir })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.files).toBe(1)
      expect(r.value.payload[0].content).toBe('hello world')
      expect(r.value.payload[0].path).toContain('a.txt')
      expect(r.value.payload[0].path.startsWith('ctx/')).toBe(true)
    }
  })

  test('directory → recursive walk packs all readable files', async () => {
    const r = await resolveSource(sharedDir, { cwd: sharedDir })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.files).toBeGreaterThanOrEqual(2)
      const paths = r.value.payload.map((f) => f.path)
      expect(paths.some((p) => p.endsWith('a.txt'))).toBe(true)
      expect(paths.some((p) => p.endsWith('deep.ts'))).toBe(true)
    }
  })

  test('.env is refused as sensitive path (single-file)', async () => {
    const r = await resolveSource(join(sharedDir, '.env'), { cwd: sharedDir })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r as { readonly error: string }).error).toContain('sensitive')
  })

  test('non-existent path returns error', async () => {
    const r = await resolveSource('/tmp/rlm-no-such-path-12345', { cwd: sharedDir })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r as { readonly error: string }).error).toContain('not found')
  })

  test('git URL scheme returns an error', async () => {
    const r = await resolveSource('https://github.com/foo/bar.git', { cwd: sharedDir })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r as { readonly error: string }).error).toContain('not supported')
  })

  test('empty source returns an error', async () => {
    const r = await resolveSource('', { cwd: sharedDir })
    expect(r.ok).toBe(false)
  })

  test('directory walks include skipped entry for .env', async () => {
    const r = await resolveSource(sharedDir, { cwd: sharedDir })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // .env should be in the skipped list (walk picks it up)
      expect(r.value.skipped.some((s) => s.path.includes('.env'))).toBe(true)
    }
  })
})
