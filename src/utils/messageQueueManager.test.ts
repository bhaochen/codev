import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UUID } from 'crypto'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  clearCommandQueue,
  dequeue,
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
  resetCommandQueue,
  restorePendingNotifications,
} from './messageQueueManager.js'
import {
  __setPendingNotificationStoreForTests,
  type NotificationPersistence,
} from '../services/db/pendingNotificationStore.js'

function notification(uuid: UUID, value = `n-${uuid}`): QueuedCommand {
  return { value, mode: 'task-notification', uuid }
}

function makeFakePersistence(): NotificationPersistence & {
  persisted: Array<{ uuid: string; projectDir: string }>
  forgotten: string[]
  loadResult: QueuedCommand[]
} {
  return {
    persisted: [],
    forgotten: [],
    loadResult: [],
    persist(cmd, ctx) {
      this.persisted.push({
        uuid: cmd.uuid ?? '(none)',
        projectDir: ctx.projectDir,
      })
    },
    forget(uuids) {
      this.forgotten.push(...uuids)
    },
    load() {
      return this.loadResult
    },
  }
}

describe('messageQueueManager notification identity + durability', () => {
  let fake: ReturnType<typeof makeFakePersistence>

  beforeEach(() => {
    fake = makeFakePersistence()
    __setPendingNotificationStoreForTests(fake)
    resetCommandQueue()
  })

  afterEach(() => {
    resetCommandQueue()
    __setPendingNotificationStoreForTests(null)
  })

  it('assigns a uuid when the producer did not', () => {
    enqueuePendingNotification({ value: 'x', mode: 'task-notification' })
    expect(getCommandQueue()[0]!.uuid).toBeDefined()
  })

  it('drops duplicate enqueues by uuid (single persist)', () => {
    const cmd = notification('00000000-0000-4000-8000-0000000000a1')
    enqueuePendingNotification(cmd)
    enqueuePendingNotification({ ...cmd, value: 'retry' })

    expect(getCommandQueue()).toHaveLength(1)
    expect(getCommandQueue()[0]!.value).toBe('n-00000000-0000-4000-8000-0000000000a1')
    expect(fake.persisted).toHaveLength(1)
  })

  it('mirrors notifications but not user commands', () => {
    enqueuePendingNotification(notification('00000000-0000-4000-8000-0000000000b1'))
    enqueue({ value: 'user prompt', mode: 'prompt' })

    expect(fake.persisted).toHaveLength(1)
    expect(fake.persisted[0]!.uuid).toBe('00000000-0000-4000-8000-0000000000b1')
  })

  it('forgets the mirror when a notification is delivered', () => {
    enqueuePendingNotification(notification('00000000-0000-4000-8000-0000000000c1'))
    const delivered = dequeue()

    expect(delivered?.uuid).toBe('00000000-0000-4000-8000-0000000000c1')
    expect(fake.forgotten).toEqual(['00000000-0000-4000-8000-0000000000c1'])
  })

  it('forgets mirrors when the queue is cleared', () => {
    enqueuePendingNotification(notification('00000000-0000-4000-8000-0000000000d1'))
    enqueuePendingNotification(notification('00000000-0000-4000-8000-0000000000d2'))
    clearCommandQueue()

    expect(fake.forgotten).toEqual([
      '00000000-0000-4000-8000-0000000000d1',
      '00000000-0000-4000-8000-0000000000d2',
    ])
  })

  it('restores persisted notifications into the queue without re-persisting', () => {
    fake.loadResult = [
      notification('00000000-0000-4000-8000-0000000000e1', 'restored-1'),
      notification('00000000-0000-4000-8000-0000000000e2', 'restored-2'),
    ]

    const restored = restorePendingNotifications('/proj')

    expect(restored).toBe(2)
    const queued = getCommandQueue()
    expect(queued.map(cmd => cmd.value)).toEqual(['restored-1', 'restored-2'])
    expect(fake.persisted).toHaveLength(0)
  })

  it('collapse already-queued commands on restore (uuid dedup)', () => {
    const live = notification('00000000-0000-4000-8000-0000000000f1', 'live')
    enqueuePendingNotification(live)
    fake.loadResult = [live]

    expect(restorePendingNotifications('/proj')).toBe(0)
    expect(getCommandQueue()).toHaveLength(1)
  })

  it('returns 0 when nothing was persisted', () => {
    expect(restorePendingNotifications('/proj')).toBe(0)
  })
})
