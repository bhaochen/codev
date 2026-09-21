import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureWorktreesDirExcluded } from './worktree.js'

const dirs: string[] = []

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-worktree-exclude-'))
  const res = spawnSync('git', ['init', '-q', dir], { encoding: 'utf-8' })
  if (res.status !== 0) throw new Error(`git init failed: ${res.stderr}`)
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('ensureWorktreesDirExcluded', () => {
  test('writes the worktrees pattern into a fresh repo exclude file', async () => {
    const dir = await makeRepo()
    await ensureWorktreesDirExcluded(dir)
    const exclude = await readFile(join(dir, '.git', 'info', 'exclude'), 'utf-8')
    expect(exclude).toContain('.claude/worktrees/')
  })

  test('does not duplicate the pattern on repeat calls', async () => {
    const dir = await makeRepo()
    await ensureWorktreesDirExcluded(dir)
    await ensureWorktreesDirExcluded(dir)
    const exclude = await readFile(join(dir, '.git', 'info', 'exclude'), 'utf-8')
    const matches = exclude
      .split(/\r?\n/)
      .filter(line => line.trim() === '.claude/worktrees/')
    expect(matches).toHaveLength(1)
  })
})
