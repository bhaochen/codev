/**
 * Memory file mirror tests — sync (disk → rows) and restore (rows → disk).
 *
 * Covers the "user wiped ~/.claude/projects" scenario end to end: write
 * memory files, mirror them, delete the tree, and verify the read-path
 * restore rebuilds it from rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test' // eslint-disable-line import/no-unresolved
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './SessionStore.js'
import {
  memoryScopeForDir,
  persistMemoryFile,
  restoreMemoryDirIfMissing,
  syncMemoryDirFromDisk,
  __resetMemoryMirrorForTests,
} from './memoryMirror.js'
import {
  __setShadowStoreForTests,
  __resetShadowWriterForTests,
} from './shadowWriter.js'

describe('memoryMirror', () => {
  let dir: string
  let store: SessionStore
  let projectsRoot: string
  let memDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-mirror-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.CODEV_DB_PRIMARY = '1'
    process.env.TEST_ENABLE_SHADOW_WRITER = '1'
    projectsRoot = join(dir, 'projects', '-home-yuki-proj')
    memDir = join(projectsRoot, 'memory')
    mkdirSync(memDir, { recursive: true })
    store = SessionStore.open(join(dir, 'store.db'))
    __setShadowStoreForTests(store)
    __resetShadowWriterForTests()
    __resetMemoryMirrorForTests()
  })

  afterEach(() => {
    __setShadowStoreForTests(null)
    __resetShadowWriterForTests()
    __resetMemoryMirrorForTests()
    delete process.env.CODEV_DB_PRIMARY
    delete process.env.TEST_ENABLE_SHADOW_WRITER
    delete process.env.CLAUDE_CONFIG_DIR
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('derives the scope from the projects layout (default + override)', () => {
    expect(memoryScopeForDir(memDir)).toBe('-home-yuki-proj')
    expect(memoryScopeForDir(memDir + '/')).toBe('-home-yuki-proj')
    expect(memoryScopeForDir(join(memDir, 'team'))).toBe('-home-yuki-proj')
    // Non-default layout (env/settings override) falls back to the abs path.
    expect(memoryScopeForDir('/tmp/some-other-memory')).toBe(
      '/tmp/some-other-memory',
    )
  })

  it('syncs nested .md files and skips dotfiles', async () => {
    writeFileSync(
      join(memDir, 'MEMORY.md'),
      '# Memory\n- [project] uses bun\n',
    )
    mkdirSync(join(memDir, 'logs', '2026', '10'), { recursive: true })
    writeFileSync(join(memDir, 'logs', '2026', '10', '2026-10-17.md'), 'day')
    writeFileSync(join(memDir, 'user_role.md'), '---\ntype: user\n---\ndev')
    writeFileSync(join(memDir, '.consolidate-lock'), 'lock')

    const n = await syncMemoryDirFromDisk(memDir)
    expect(n).toBe(3)
    const rows = store.getMemoryFiles('-home-yuki-proj')
    expect(rows.map(r => r.relPath).sort()).toEqual([
      'MEMORY.md',
      'logs/2026/10/2026-10-17.md',
      'user_role.md',
    ])
    expect(rows.find(r => r.relPath === 'user_role.md')!.content).toContain(
      'type: user',
    )
  })

  it('propagates deletions: full replace drops rows for removed files', async () => {
    writeFileSync(join(memDir, 'MEMORY.md'), 'idx')
    writeFileSync(join(memDir, 'old_topic.md'), 'stale')
    await syncMemoryDirFromDisk(memDir)
    expect(store.getMemoryFiles('-home-yuki-proj')).toHaveLength(2)

    rmSync(join(memDir, 'old_topic.md'))
    await syncMemoryDirFromDisk(memDir)
    expect(
      store.getMemoryFiles('-home-yuki-proj').map(r => r.relPath),
    ).toEqual(['MEMORY.md'])
  })

  it('restores the whole dir from rows when MEMORY.md is missing', async () => {
    writeFileSync(join(memDir, 'MEMORY.md'), '# index')
    mkdirSync(join(memDir, 'topics'), { recursive: true })
    writeFileSync(join(memDir, 'topics', 'stack.md'), 'bun + sqlite')
    await syncMemoryDirFromDisk(memDir)

    // User wipes the projects tree.
    rmSync(join(dir, 'projects'), { recursive: true, force: true })
    expect(existsSync(memDir)).toBe(false)

    const restored = await restoreMemoryDirIfMissing(memDir)
    expect(restored).toBe(true)
    expect(readFileSync(join(memDir, 'MEMORY.md'), 'utf8')).toBe('# index')
    expect(readFileSync(join(memDir, 'topics', 'stack.md'), 'utf8')).toBe(
      'bun + sqlite',
    )

    // Second restore is a no-op (entrypoint present).
    expect(await restoreMemoryDirIfMissing(memDir)).toBe(false)
  })

  it('does not resurrect an individually deleted file while MEMORY.md survives', async () => {
    writeFileSync(join(memDir, 'MEMORY.md'), '# index')
    writeFileSync(join(memDir, 'pruned.md'), 'old memory')
    await syncMemoryDirFromDisk(memDir)

    // The agent intentionally prunes one topic file.
    rmSync(join(memDir, 'pruned.md'))
    expect(await restoreMemoryDirIfMissing(memDir)).toBe(false)
    expect(existsSync(join(memDir, 'pruned.md'))).toBe(false)
    // The deletion propagates to the rows on the next sync.
    await syncMemoryDirFromDisk(memDir)
    expect(
      store.getMemoryFiles('-home-yuki-proj').map(r => r.relPath),
    ).toEqual(['MEMORY.md'])
  })

  it('returns false when there is nothing to restore (fresh project)', async () => {
    expect(await restoreMemoryDirIfMissing(memDir)).toBe(false)
    expect(existsSync(join(memDir, 'MEMORY.md'))).toBe(false)
  })

  it('persistMemoryFile upserts one row without touching siblings', async () => {
    // The persist seam resolves the memory dir through memdir/paths.js, so
    // this test uses the REAL derived dir for the repo under test.
    const { getAutoMemPath } = await import('../../memdir/paths.js')
    const realMemDir = getAutoMemPath()
    const scope = memoryScopeForDir(realMemDir)
    mkdirSync(realMemDir, { recursive: true })
    writeFileSync(join(realMemDir, 'MEMORY.md'), '# index')
    await syncMemoryDirFromDisk(realMemDir)
    expect(store.getMemoryFiles(scope)).toHaveLength(1)

    // A tool-write seam upsert: new file lands as its own row, sibling kept.
    expect(await persistMemoryFile(join(realMemDir, 'user_role.md'), 'dev')).toBe(
      true,
    )
    const rows = store.getMemoryFiles(scope)
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.relPath === 'user_role.md')!.content).toBe('dev')

    // Content update through the seam (no full replace).
    expect(await persistMemoryFile(join(realMemDir, 'user_role.md'), 'dev v2')).toBe(
      true,
    )
    expect(
      store
        .getMemoryFiles(scope)
        .find(r => r.relPath === 'user_role.md')!.content,
    ).toBe('dev v2')

    // Non-memory paths are ignored.
    expect(await persistMemoryFile(join(dir, 'elsewhere.md'), 'x')).toBe(false)
  })
})
