import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import {
  __setPendingNotificationStoreForTests,
  __setBackgroundTaskStoreForTests,
  type BackgroundTaskPersistence,
  type BackgroundTaskRow,
  type NotificationPersistence,
} from '../../services/db/pendingNotificationStore.js'
import {
  clearCommandQueue,
  getCommandQueue,
  resetCommandQueue,
} from '../messageQueueManager.js'
import { deterministicUuid } from '../deterministicUuid.js'
import { recoverOrphanedBackgroundTasks } from './recovery.js'

const PROJECT = '/proj'

function makeFakes(rows: BackgroundTaskRow[]): {
  background: BackgroundTaskPersistence & { untracked: string[] }
  notifications: NotificationPersistence & { persisted: QueuedCommand[] }
} {
  const background = {
    track: () => {},
    untracked: [] as string[],
    untrack(taskId: string): void {
      this.untracked.push(taskId)
    },
    loadOrphaned: () => rows,
  }
  const notifications = {
    persisted: [] as QueuedCommand[],
    persist(cmd: QueuedCommand): void {
      this.persisted.push(cmd)
    },
    forget: () => {},
    load: () => [] as QueuedCommand[],
  }
  return { background, notifications }
}

describe('recoverOrphanedBackgroundTasks', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recovery-'))
    resetCommandQueue()
  })

  afterEach(() => {
    __setPendingNotificationStoreForTests(null)
    __setBackgroundTaskStoreForTests(null)
    resetCommandQueue()
    rmSync(dir, { recursive: true, force: true })
  })

  it('converts orphaned running tasks into statusless notifications with tail', async () => {
    const outputPath = join(dir, 't1.output')
    writeFileSync(outputPath, 'step 1 done\nstep 2 done\npartial ste')
    const fakes = makeFakes([
      {
        taskId: 't1',
        projectDir: PROJECT,
        sessionId: null,
        description: 'long build',
        kind: 'bash',
        outputPath,
        startedAt: Date.now(),
      },
    ])
    __setBackgroundTaskStoreForTests(fakes.background)
    __setPendingNotificationStoreForTests(fakes.notifications)

    const recovered = await recoverOrphanedBackgroundTasks(PROJECT)

    expect(recovered).toBe(1)
    expect(fakes.background.untracked).toEqual(['t1'])
    const queued = getCommandQueue()
    expect(queued).toHaveLength(1)
    const cmd = queued[0]!
    expect(cmd.mode).toBe('task-notification')
    // Statusless (no <status> tag): unknown statuses would falsely close the
    // task for SDK consumers — same convention as the stall watchdog.
    expect(cmd.value).not.toContain('<status>')
    expect(cmd.value).toContain('<task-id>t1</task-id>')
    expect(cmd.value).toContain('was still running when the previous process exited')
    expect(cmd.value).toContain('Last output:')
    expect(cmd.value).toContain('partial ste')
    // Durable + idempotent identity.
    expect(cmd.uuid).toBe(deterministicUuid('task-notification:t1:lost'))
    expect(fakes.notifications.persisted.map(c => c.uuid)).toEqual([cmd.uuid])
  })

  it('notifies even when the output file is gone', async () => {
    const fakes = makeFakes([
      {
        taskId: 'gone',
        projectDir: PROJECT,
        sessionId: null,
        description: 'vanished',
        kind: 'bash',
        outputPath: join(dir, 'missing.output'),
        startedAt: Date.now(),
      },
    ])
    __setBackgroundTaskStoreForTests(fakes.background)
    __setPendingNotificationStoreForTests(fakes.notifications)

    const recovered = await recoverOrphanedBackgroundTasks(PROJECT)

    expect(recovered).toBe(1)
    const cmd = getCommandQueue()[0]!
    expect(cmd.value).toContain('was still running when the previous process exited')
    expect(cmd.value).not.toContain('Last output:')
  })

  it('is a no-op with no orphaned tasks', async () => {
    const fakes = makeFakes([])
    __setBackgroundTaskStoreForTests(fakes.background)
    __setPendingNotificationStoreForTests(fakes.notifications)

    expect(await recoverOrphanedBackgroundTasks(PROJECT)).toBe(0)
    expect(getCommandQueue()).toHaveLength(0)
    clearCommandQueue()
  })
})
