import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorkerPath } from '../sandbox.js'

describe('RLM worker path', () => {
  test('resolves to an existing worker in the source tree', () => {
    const path = resolveWorkerPath()
    expect(existsSync(path)).toBe(true)
    expect(path.endsWith('/py/worker.py')).toBe(true)
  })

  test('falls back to the directory beside the compiled executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlm-worker-path-test-'))
    try {
      await mkdir(join(root, 'py'))
      const worker = join(root, 'py', 'worker.py')
      await writeFile(worker, '# test worker')
      expect(resolveWorkerPath('file:///missing/bundle/sandbox.js', join(root, 'codev'))).toBe(worker)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
