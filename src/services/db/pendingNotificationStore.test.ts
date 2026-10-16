import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UUID } from 'crypto'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import {
  __resetPendingNotificationStoreForTests,
  __setPendingNotificationStoreForTests,
  sqliteNotificationPersistence,
} from './pendingNotificationStore.js'

const PROJECT = '/proj'

function notification(
  uuid: UUID,
  value = `notification ${uuid}`,
): QueuedCommand {
  return {
    value,
    mode: 'task-notification',
    priority: 'later',
    uuid,
    agentId: undefined,
    isMeta: false,
  }
}

describe('pendingNotificationStore (SQLite mirror)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pending-notifications-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    // bun test would normally select the no-op backend; pin the real one.
    __setPendingNotificationStoreForTests(sqliteNotificationPersistence)
    __resetPendingNotificationStoreForTests()
  })

  afterEach(() => {
    __setPendingNotificationStoreForTests(null)
    __resetPendingNotificationStoreForTests()
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('roundtrips a persisted notification for the same project', () => {
    const cmd = notification('00000000-0000-4000-8000-0000000000a1')
    sqliteNotificationPersistence.persist(cmd, {
      projectDir: PROJECT,
      sessionId: 's1',
    })

    const loaded = sqliteNotificationPersistence.load(PROJECT)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.uuid).toBe(cmd.uuid)
    expect(loaded[0]!.value).toBe(cmd.value)
    expect(loaded[0]!.mode).toBe('task-notification')
    expect(loaded[0]!.priority).toBe('later')
  })

  it('scopes rows by project dir', () => {
    sqliteNotificationPersistence.persist(notification('00000000-0000-4000-8000-0000000000b1'), {
      projectDir: PROJECT,
      sessionId: null,
    })
    expect(sqliteNotificationPersistence.load('/other-project')).toEqual([])
    expect(sqliteNotificationPersistence.load(PROJECT)).toHaveLength(1)
  })

  it('is idempotent per uuid (INSERT OR IGNORE)', () => {
    const uuid = '00000000-0000-4000-8000-0000000000c1'
    sqliteNotificationPersistence.persist(notification(uuid, 'first'), {
      projectDir: PROJECT,
      sessionId: null,
    })
    sqliteNotificationPersistence.persist(notification(uuid, 'second'), {
      projectDir: PROJECT,
      sessionId: null,
    })

    const loaded = sqliteNotificationPersistence.load(PROJECT)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.value).toBe('first')
  })

  it('deletes rows on forget', () => {
    const a = '00000000-0000-4000-8000-0000000000d1'
    const b = '00000000-0000-4000-8000-0000000000d2'
    sqliteNotificationPersistence.persist(notification(a), {
      projectDir: PROJECT,
      sessionId: null,
    })
    sqliteNotificationPersistence.persist(notification(b), {
      projectDir: PROJECT,
      sessionId: null,
    })

    sqliteNotificationPersistence.forget([a])
    const loaded = sqliteNotificationPersistence.load(PROJECT)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.uuid).toBe(b)
  })

  it('orders replay by creation time', () => {
    const first = notification('00000000-0000-4000-8000-0000000000e1', 'first')
    const second = notification('00000000-0000-4000-8000-0000000000e2', 'second')
    sqliteNotificationPersistence.persist(first, {
      projectDir: PROJECT,
      sessionId: null,
    })
    sqliteNotificationPersistence.persist(second, {
      projectDir: PROJECT,
      sessionId: null,
    })
    const loaded = sqliteNotificationPersistence.load(PROJECT)
    expect(loaded.map(cmd => cmd.value)).toEqual(['first', 'second'])
  })
})
