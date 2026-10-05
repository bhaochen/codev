import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listSnapshots,
  revertSnapshot,
  snapshotDiff,
  snapshotDiffBetween,
  trackSnapshot,
} from './snapshot.js'

const ORIGINAL_SNAPSHOT_DIR = process.env.CODEV_SNAPSHOT_DIR
let projectDir: string
let snapshotDir: string

function git(project: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Snapshot Test',
      GIT_AUTHOR_EMAIL: 'snapshot-test@example.invalid',
      GIT_COMMITTER_NAME: 'Snapshot Test',
      GIT_COMMITTER_EMAIL: 'snapshot-test@example.invalid',
    },
  }).trim()
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'codev-snapshot-project-'))
  snapshotDir = await mkdtemp(join(tmpdir(), 'codev-snapshot-store-'))
  process.env.CODEV_SNAPSHOT_DIR = snapshotDir
  git(projectDir, 'init', '--quiet')
  git(projectDir, 'config', 'user.name', 'Snapshot Test')
  git(projectDir, 'config', 'user.email', 'snapshot-test@example.invalid')
})

afterEach(async () => {
  if (ORIGINAL_SNAPSHOT_DIR === undefined) {
    delete process.env.CODEV_SNAPSHOT_DIR
  } else {
    process.env.CODEV_SNAPSHOT_DIR = ORIGINAL_SNAPSHOT_DIR
  }
  await rm(projectDir, { recursive: true, force: true })
  await rm(snapshotDir, { recursive: true, force: true })
})

describe('shadow Git snapshots', () => {
  test('saves, lists, diffs, and restores without touching project Git metadata', async () => {
    const sourcePath = join(projectDir, 'src', 'module.ts')
    await mkdir(join(projectDir, 'src'))
    await writeFile(sourcePath, 'export const value = 1\n')
    await writeFile(join(projectDir, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(projectDir, 'ignored.txt'), 'ignore me\n')
    git(projectDir, 'add', '.gitignore', 'src/module.ts')
    git(projectDir, 'commit', '--quiet', '-m', 'base')
    const projectHead = git(projectDir, 'rev-parse', 'HEAD')
    const projectIndex = await readFile(join(projectDir, '.git', 'index'))

    const base = await trackSnapshot(projectDir, 'baseline')
    await writeFile(sourcePath, 'export const value = 2\n')
    await writeFile(join(projectDir, 'new file.ts'), 'export const fresh = true\n')
    const next = await trackSnapshot(projectDir, 'second approach')

    expect((await listSnapshots(projectDir)).map(entry => entry.message)).toEqual([
      'snapshot: second approach',
      'snapshot: baseline',
    ])
    const between = await snapshotDiffBetween(projectDir, base.hash, next.hash)
    expect(between.map(file => [file.file, file.status])).toEqual([
      ['new file.ts', 'added'],
      ['src/module.ts', 'modified'],
    ])
    expect(between.find(file => file.file === 'src/module.ts')?.patch).toContain(
      '+export const value = 2',
    )

    await writeFile(sourcePath, 'uncommitted current value\n')
    const againstWorkingTree = await snapshotDiff(projectDir, base.hash)
    expect(againstWorkingTree.map(file => file.file)).toContain('src/module.ts')
    await revertSnapshot(projectDir, base.hash)

    expect(await readFile(sourcePath, 'utf8')).toBe('export const value = 1\n')
    expect(await readFile(join(projectDir, 'new file.ts'), 'utf8')).toBe(
      'export const fresh = true\n',
    )
    expect(await readFile(join(projectDir, 'ignored.txt'), 'utf8')).toBe('ignore me\n')
    expect(git(projectDir, 'rev-parse', 'HEAD')).toBe(projectHead)
    expect(await readFile(join(projectDir, '.git', 'index'))).toEqual(projectIndex)
  })

  test('captures deletes, honors the file size cap, and rejects unknown hashes', async () => {
    const deletedPath = join(projectDir, 'will-delete.ts')
    const largePath = join(projectDir, 'large.bin')
    await writeFile(deletedPath, 'present in first snapshot\n')
    await writeFile(largePath, Buffer.alloc(2 * 1024 * 1024 + 1, 1))
    const before = await trackSnapshot(projectDir, 'before delete')

    await rm(deletedPath)
    await writeFile(largePath, Buffer.alloc(2 * 1024 * 1024 + 1, 2))
    const after = await trackSnapshot(projectDir, 'after delete')
    const diff = await snapshotDiffBetween(projectDir, before.hash, after.hash)

    expect(diff).toContainEqual(
      expect.objectContaining({ file: 'will-delete.ts', status: 'deleted' }),
    )
    expect(diff.map(file => file.file)).not.toContain('large.bin')
    await revertSnapshot(projectDir, before.hash)
    expect(await readFile(deletedPath, 'utf8')).toBe('present in first snapshot\n')
    const largeContents = await readFile(largePath)
    expect(largeContents.length).toBe(2 * 1024 * 1024 + 1)
    expect(largeContents[0]).toBe(2)
    await expect(revertSnapshot(projectDir, 'not-a-hash')).rejects.toThrow(
      'invalid snapshot hash',
    )
  })
})
