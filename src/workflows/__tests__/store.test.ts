import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowSnapshot } from '../types.js'
import { WorkflowStore } from '../store.js'

function snap(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    status: 'running',
    currentNode: 'a',
    activeNode: null,
    stepCount: 0,
    attempts: {},
    outputs: {},
    error: null,
    lastError: null,
    input: {},
    ...overrides,
  }
}

async function openTempStore(): Promise<{ store: WorkflowStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codev-wf-store-'))
  return { store: WorkflowStore.open(join(dir, 'state.sqlite')), dir }
}

describe('WorkflowStore', () => {
  test('create + get roundtrips input and snapshot', async () => {
    const { store, dir } = await openTempStore()
    try {
      const id = store.createRun({
        workflowName: 'echo',
        sourcePath: '/proj/.claude/workflows/echo.workflow.ts',
        sessionId: 'sess-1',
        input: { task: 'hi' },
        snapshot: snap({ input: { task: 'hi' } }),
      })
      const run = store.getRun(id)
      expect(run).not.toBeNull()
      expect(run!.workflowName).toBe('echo')
      expect(run!.sessionId).toBe('sess-1')
      expect(run!.ownerLease).toBeNull()
      expect(run!.input).toEqual({ task: 'hi' })
      expect(run!.status).toBe('running')
      expect(store.getRun('missing')).toBeNull()
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('updateRun mirrors snapshot status and bumps updatedAt', async () => {
    const { store, dir } = await openTempStore()
    try {
      const id = store.createRun({
        workflowName: 'w',
        sessionId: 's',
        input: {},
        snapshot: snap(),
      })
      const before = store.getRun(id)!
      store.updateRun(id, snap({ status: 'waiting', currentNode: 'gate', activeNode: 'gate' }))
      const after = store.getRun(id)!
      expect(after.status).toBe('waiting')
      expect(after.snapshot.activeNode).toBe('gate')
      expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('owner lease set/clear; unknown id returns false', async () => {
    const { store, dir } = await openTempStore()
    try {
      const id = store.createRun({ workflowName: 'w', sessionId: 's', input: {}, snapshot: snap() })
      expect(store.setOwnerLease(id, 'lease-1')).toBe(true)
      expect(store.getRun(id)!.ownerLease).toBe('lease-1')
      expect(store.setOwnerLease(id, null)).toBe(true)
      expect(store.getRun(id)!.ownerLease).toBeNull()
      expect(store.setOwnerLease('nope', 'x')).toBe(false)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('listRuns filters by session and status, newest first', async () => {
    const { store, dir } = await openTempStore()
    try {
      const a = store.createRun({ workflowName: 'w', sessionId: 's1', input: {}, snapshot: snap() })
      const other = store.createRun({ workflowName: 'w', sessionId: 's2', input: {}, snapshot: snap() })
      store.updateRun(a, snap({ status: 'completed', currentNode: null }))
      const b = store.createRun({ workflowName: 'w', sessionId: 's1', input: {}, snapshot: snap() })

      const s1 = store.listRuns({ sessionId: 's1' })
      expect(s1.map(r => r.id)).toEqual([b, a])

      const done = store.listRuns({ statuses: ['completed'] })
      expect(done.map(r => r.id)).toEqual([a])

      const active = store.listRuns({ statuses: ['running', 'paused', 'waiting'] })
      expect(active.map(r => r.id)).toEqual([b, other])
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('events append in order with structured payloads', async () => {
    const { store, dir } = await openTempStore()
    try {
      const id = store.createRun({ workflowName: 'w', sessionId: 's', input: {}, snapshot: snap() })
      store.appendEvent(id, 'run_started', { name: 'w' })
      store.appendEvent(id, 'node_completed', { node: 'a' })
      const events = store.events(id)
      expect(events.map(e => e.type)).toEqual(['run_started', 'node_completed'])
      expect(events[0]!.data).toEqual({ name: 'w' })
      expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
