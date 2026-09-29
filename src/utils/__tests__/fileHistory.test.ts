/**
 * Regression tests for the rewind prompt's code restore.
 *
 * The Rewind picker used to render per-message diff stats computed from the
 * tool_use records in the message log (structuredPatch), while the actual
 * restore read real file backups. The two could disagree: the list could
 * promise "3 files changed +40 -12" for a checkpoint whose files matched disk
 * exactly, so selecting it silently restored nothing.
 *
 * These tests pin the invariant that matters: whatever fileHistoryGetDiffStats
 * reports as restorable, fileHistoryRewind genuinely puts back on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { UUID } from 'crypto'
import {
  fileHistoryGetDiffStats,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from '../fileHistory.js'
import { setIsInteractive, setOriginalCwd } from 'src/bootstrap/state.js'

const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
const ORIGINAL_CWD = process.cwd()

let workDir: string
let configDir: string

/**
 * Holds the FileHistoryState the way the REPL does: fileHistory calls the
 * updater to both read and write, so the harness must persist whatever the
 * updater returns or every snapshot is silently discarded.
 */
let state: FileHistoryState

function updateFileHistoryState(
  updater: (prev: FileHistoryState) => FileHistoryState,
): void {
  const next = updater(state)
  if (next !== state) state = next
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'codev-rewind-work-'))
  configDir = await mkdtemp(join(tmpdir(), 'codev-rewind-config-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.chdir(workDir)

  // fileHistoryEnabled() branches on getIsNonInteractiveSession(), which
  // defaults to true and would route to the SDK gate (env opt-in only).
  setIsInteractive(true)
  // maybeShortenFilePath() relativizes against originalCwd; without this the
  // tracked paths stay absolute and still work, but keep it pointed at the
  // temp dir so nothing resolves against the repo.
  setOriginalCwd(workDir)

  state = {
    snapshots: [],
    trackedFiles: new Set<string>(),
    snapshotSequence: 0,
  }
})

afterEach(async () => {
  process.chdir(ORIGINAL_CWD)
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  }
  await rm(workDir, { recursive: true, force: true })
  await rm(configDir, { recursive: true, force: true })
})

describe('fileHistory rewind restores what the picker promised', () => {
  test('diff stats reported for a checkpoint are actually reverted on disk', async () => {
    const targetMessage = 'msg-target' as UUID
    const filePath = join(workDir, 'app.ts')
    await writeFile(filePath, 'export const v = 1\n', 'utf-8')

    await fileHistoryMakeSnapshot(updateFileHistoryState, targetMessage)
    await fileHistoryTrackEdit(
      updateFileHistoryState,
      filePath,
      targetMessage,
    )
    await writeFile(
      filePath,
      'export const v = 2\nexport const w = 3\n',
      'utf-8',
    )

    // The picker reads this to decide whether to offer "Restore code".
    const stats = await fileHistoryGetDiffStats(state, targetMessage)
    expect(stats?.filesChanged?.length).toBe(1)
    expect(stats?.insertions ?? 0).toBeGreaterThan(0)

    await fileHistoryRewind(updateFileHistoryState, targetMessage)

    expect(await readFile(filePath, 'utf-8')).toBe('export const v = 1\n')

    // After a rewind the checkpoint no longer reports pending changes — the
    // list and the confirm screen must agree in both directions.
    const after = await fileHistoryGetDiffStats(state, targetMessage)
    expect(after?.filesChanged ?? []).toEqual([])
  })

  test('a file matching its backup reports no restorable changes', async () => {
    const targetMessage = 'msg-noop' as UUID
    const filePath = join(workDir, 'stable.ts')
    await writeFile(filePath, 'unchanged\n', 'utf-8')

    await fileHistoryMakeSnapshot(updateFileHistoryState, targetMessage)

    const stats = await fileHistoryGetDiffStats(state, targetMessage)
    // This is the case the old message-log-based list got wrong: the log may
    // hold a structuredPatch for this turn, but nothing on disk differs.
    expect(stats?.filesChanged ?? []).toEqual([])
  })

  test('reverting a later edit restores the exact pre-edit bytes', async () => {
    const targetMessage = 'msg-bytes' as UUID
    const filePath = join(workDir, 'bytes.ts')
    const original = 'line1\nline2\nline3\n'
    await writeFile(filePath, original, 'utf-8')

    await fileHistoryMakeSnapshot(updateFileHistoryState, targetMessage)
    await fileHistoryTrackEdit(
      updateFileHistoryState,
      filePath,
      targetMessage,
    )
    await writeFile(filePath, 'totally\ndifferent\n', 'utf-8')

    await fileHistoryRewind(updateFileHistoryState, targetMessage)

    expect(await readFile(filePath, 'utf-8')).toBe(original)
  })

  test('a file created after the checkpoint is deleted by rewind', async () => {
    const targetMessage = 'msg-create' as UUID
    const newFile = join(workDir, 'added.ts')

    await fileHistoryMakeSnapshot(updateFileHistoryState, targetMessage)
    // trackEdit runs before the write, so the file does not exist yet and the
    // backup is recorded as "did not exist at this version" (null).
    await fileHistoryTrackEdit(
      updateFileHistoryState,
      newFile,
      targetMessage,
    )
    await writeFile(newFile, 'brand new\n', 'utf-8')

    const stats = await fileHistoryGetDiffStats(state, targetMessage)
    expect(stats?.filesChanged ?? []).toContain(newFile)

    await fileHistoryRewind(updateFileHistoryState, targetMessage)

    await expect(readFile(newFile, 'utf-8')).rejects.toThrow()
  })
})
