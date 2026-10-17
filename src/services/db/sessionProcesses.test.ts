/**
 * Live-session process registry (DB-backed, migration 009) — replaces the
 * per-PID JSON files in <configHome>/sessions/. Verifies the register /
 * patch / count / stale-sweep lifecycle against a real SQLite store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test' // eslint-disable-line import/no-unresolved
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionStore,
  __resetSessionStoreForTests,
} from './SessionStore.js'
import {
  countConcurrentSessions,
  registerSession,
  updateSessionBridgeId,
  updateSessionName,
} from '../../utils/concurrentSessions.js'

describe('session process registry (DB)', () => {
  let dir: string
  let store: SessionStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-processes-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.CODEV_DB_PRIMARY = '1'
    __resetSessionStoreForTests()
    store = SessionStore.open(join(dir, 'sessions', 'sessions.db'))
  })

  afterEach(() => {
    __resetSessionStoreForTests()
    delete process.env.CODEV_DB_PRIMARY
    delete process.env.CLAUDE_CONFIG_DIR
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('register writes a row; updates patch it in place', async () => {
    expect(await registerSession()).toBe(true)
    expect(store.listSessionProcessPids()).toContain(process.pid)

    const row = store.getSessionProcess(process.pid)
    expect(row).toBeTruthy()
    expect(row!.pid).toBe(process.pid)
    expect(row!.cwd).toBeTruthy()

    await updateSessionName('my-session')
    await updateSessionBridgeId('remote-123')
    const patched = store.getSessionProcess(process.pid)!
    expect(patched.name).toBe('my-session')
    expect(patched.bridgeSessionId).toBe('remote-123')
    // Untouched fields survive the patch (read-modify-write, not replace).
    expect(patched.cwd).toBe(row!.cwd)

    await updateSessionBridgeId(null)
    expect(store.getSessionProcess(process.pid)!.bridgeSessionId).toBeNull()
  })

  it('counts self and live peers, sweeps dead rows', async () => {
    expect(await registerSession()).toBe(true)

    // A live "peer" — this process forks a long-lived child.
    const { spawn } = await import('node:child_process')
    const peer = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      store.upsertSessionProcess(peer.pid!, { pid: peer.pid, kind: 'interactive' })
      // Dead peer — registered but the process never existed.
      store.upsertSessionProcess(999_999_999, { pid: 999_999_999 })

      // Self + live peer = 2 (the dead one is swept).
      expect(await countConcurrentSessions()).toBe(2)
      expect(store.listSessionProcessPids()).not.toContain(999_999_999)
      expect(store.listSessionProcessPids()).toContain(peer.pid!)
    } finally {
      peer.kill()
    }
  })

  it('returns 0 conservatively when the store cannot be counted', async () => {
    // No registration happened in this fresh store: count includes no self.
    expect(await countConcurrentSessions()).toBe(0)
  })
})
