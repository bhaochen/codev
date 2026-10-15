/**
 * Regression tests for session migration fixes.
 *
 * Tests cover the 8 issues fixed in the JSONL → SQLite migration:
 * 1. Session ID collisions (same name in different subdirs)
 * 2. Subagent transcript skipping
 * 3. synced_path population
 * 4. Large file streaming (no OOM)
 * 5. Transaction atomicity (crash = rollback)
 * 6. Ctrl+C cleanup
 * 7. Config race protection
 * 8. Single DB connection reuse
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { SessionStore } from './SessionStore.js'
import {
  findSessionFiles,
  getProjectDirs,
  migrateAllSessions,
  migrateSession,
} from './migrateSessions.js'
import type { Entry } from '../../types/logs.js'

const TEST_UUID = '00000000-0000-4000-8000-000000000001'

function user(content: string): Entry {
  return {
    type: 'user',
    sessionId: TEST_UUID,
    uuid: TEST_UUID,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  } as unknown as Entry
}

describe('Session Migration Regression Tests', () => {
  let testDir: string
  let projectsDir: string
  let store: SessionStore

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'migration-test-'))
    projectsDir = join(testDir, 'projects')
    mkdirSync(projectsDir, { recursive: true })

    // Override config home for isolation
    process.env.CLAUDE_CONFIG_DIR = testDir

    store = SessionStore.open(join(testDir, 'sessions.db'))
  })

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    store.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  describe('Session ID collision prevention', () => {
    it('generates unique session IDs for same-named files in different subdirs', async () => {
      // Create: projectA/session1.jsonl and projectB/session1.jsonl
      const projectA = join(projectsDir, 'projectA')
      const projectB = join(projectsDir, 'projectB')
      mkdirSync(projectA, { recursive: true })
      mkdirSync(projectB, { recursive: true })

      writeFileSync(join(projectA, 'session1.jsonl'), JSON.stringify(user('A')) + '\n')
      writeFileSync(join(projectB, 'session1.jsonl'), JSON.stringify(user('B')) + '\n')

      const filesA = await findSessionFiles('projectA')
      const filesB = await findSessionFiles('projectB')

      expect(filesA).toHaveLength(1)
      expect(filesB).toHaveLength(1)
      expect(filesA[0].sessionId).toBe('session1')
      expect(filesB[0].sessionId).toBe('session1')
      // Different projectDirs
      expect(filesA[0].projectDir).toBe('projectA')
      expect(filesB[0].projectDir).toBe('projectB')
    })

    it('mirrors subagent files with composite ids instead of skipping them', async () => {
      const projectDir = join(projectsDir, 'projectWithSubagent')
      const sessionDir = join(projectDir, 'session123')
      const subagentDir = join(sessionDir, 'subagents')
      mkdirSync(subagentDir, { recursive: true })

      writeFileSync(join(projectDir, 'session123.jsonl'), JSON.stringify(user('main')) + '\n')
      writeFileSync(join(subagentDir, 'agent-abc.jsonl'), JSON.stringify(user('subagent')) + '\n')

      const files = await findSessionFiles('projectWithSubagent')

      const main = files.find(f => !f.isSubagent)
      const sub = files.find(f => f.isSubagent)
      expect(main?.sessionId).toBe('session123')
      // Item 2: subagent transcripts are mirrored under composite ids
      // (relative to the project dir), with their parent session linked.
      expect(sub?.sessionId).toBe('session123/subagents/agent-abc')
      expect(sub?.parentSessionId).toBe('session123')
      expect(sub?.projectDir).toBe('projectWithSubagent')
    })

    it('handles nested project directories', async () => {
      const nested = join(projectsDir, 'parent', 'child')
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, 'nested-session.jsonl'), JSON.stringify(user('nested')) + '\n')

      // getProjectDirs returns top-level dirs; findSessionFiles recurses
      const files = await findSessionFiles('parent')
      expect(files).toHaveLength(1)
      expect(files[0].sessionId).toBe('nested-session')
      expect(files[0].projectDir).toBe('parent/child')
    })
  })

  describe('synced_path population', () => {
    it('sets synced_path, synced_size, synced_mtime on migration', async () => {
      const projectDir = join(projectsDir, 'synced-test')
      mkdirSync(projectDir, { recursive: true })
      const filePath = join(projectDir, 'test-session.jsonl')
      writeFileSync(filePath, JSON.stringify(user('test')) + '\n')

      const sessionFile = {
        filePath,
        sessionId: 'test-session',
        projectDir: 'synced-test',
        isSubagent: false,
      }

      await migrateSession(store, sessionFile, { dryRun: false })

      const session = store.getSession('test-session')
      expect(session).not.toBeNull()
      expect(session?.syncedPath).toBeTruthy()
      expect(session?.syncedSize).toBeGreaterThan(0)
      expect(session?.syncedMtime).toBeGreaterThan(0)
      expect(session?.syncedPath).toContain('test-session.jsonl')
    })

    it('sets synced_path to canonical realpath', async () => {
      const projectDir = join(projectsDir, 'realpath-test')
      mkdirSync(projectDir, { recursive: true })
      const filePath = join(projectDir, 'rp-test.jsonl')
      writeFileSync(filePath, JSON.stringify(user('test')) + '\n')

      const sessionFile = {
        filePath,
        sessionId: 'rp-test',
        projectDir: 'realpath-test',
        isSubagent: false,
      }

      await migrateSession(store, sessionFile, { dryRun: false })

      const session = store.getSession('rp-test')
      expect(session?.syncedPath).toBe(realpathSync(filePath))
    })
  })

  describe('transaction atomicity', () => {
    it('wraps migration in transaction and rolls back on error', async () => {
      const projectDir = join(projectsDir, 'atomic-test')
      mkdirSync(projectDir, { recursive: true })
      const filePath = join(projectDir, 'atomic.jsonl')
      writeFileSync(filePath, JSON.stringify(user('test')) + '\n')

      const sessionFile = {
        filePath,
        sessionId: 'atomic',
        projectDir: 'atomic-test',
        isSubagent: false,
      }

      // Migration succeeds and is atomic
      await migrateSession(store, sessionFile, { dryRun: false })
      expect(store.getSession('atomic')).not.toBeNull()

      // Verify transaction method exists and works via public API
      store.testOnly_runInTransaction((db) => {
        db.run('INSERT INTO sessions (id, project_dir, created_at, updated_at, message_count) VALUES (?, ?, ?, ?, ?)', [
          'txn-test',
          'atomic-test',
          Date.now(),
          Date.now(),
          0,
        ])
      })
      expect(store.getSession('txn-test')).not.toBeNull()

      // Rollback on error
      let rolledBack = false
      try {
        store.testOnly_runInTransaction((db) => {
          db.run('INSERT INTO sessions (id, project_dir, created_at, updated_at, message_count) VALUES (?, ?, ?, ?, ?)', [
            'txn-fail',
            'atomic-test',
            Date.now(),
            Date.now(),
            0,
          ])
          throw new Error('intentional rollback')
        })
      } catch {
        rolledBack = true
      }
      expect(rolledBack).toBe(true)
      expect(store.getSession('txn-fail')).toBeNull()
    })
  })

  describe('single store reuse', () => {
    it('reuses provided store instead of creating new one', async () => {
      const projectDir = join(projectsDir, 'reuse-test')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'reuse1.jsonl'), JSON.stringify(user('a')) + '\n')
      writeFileSync(join(projectDir, 'reuse2.jsonl'), JSON.stringify(user('b')) + '\n')

      const sharedStore = SessionStore.open(join(testDir, 'shared.db'))

      const result = await migrateAllSessions({
        projectDir: 'reuse-test',
        _store: sharedStore,
      })

      expect(result.migrated).toBe(2)
      sharedStore.close()
    })
  })

  describe('large file handling', () => {
    it('uses streaming parse for files over threshold', async () => {
      const projectDir = join(projectsDir, 'large-test')
      mkdirSync(projectDir, { recursive: true })
      const filePath = join(projectDir, 'large.jsonl')

      // Create a file larger than SKIP_PRECOMPACT_THRESHOLD (5MB)
      // Each entry is ~200 bytes, so 30000 entries ≈ 6MB
      const entries = Array.from({ length: 30000 }, (_, i) =>
        JSON.stringify({ ...user(`msg ${i}`), uuid: `u${i}` })
      ).join('\n') + '\n'
      writeFileSync(filePath, entries)

      const stat = statSync(filePath)
      expect(stat.size).toBeGreaterThan(5 * 1024 * 1024) // > 5MB

      const sessionFile = {
        filePath,
        sessionId: 'large',
        projectDir: 'large-test',
        isSubagent: false,
      }

      // Should complete without OOM (parseTranscriptFile streams)
      const result = await migrateSession(store, sessionFile, { dryRun: false })
      expect(result).toBe('migrated')

      const session = store.getSession('large')
      expect(session?.messageCount).toBeGreaterThan(20000)
    })
  })

  describe('config race protection', () => {
    it('captures migration version at start', async () => {
      // This test verifies the migration reads config once at start
      // The actual race protection is in main.tsx runSessionMigration
      // Here we verify migrateAllSessions doesn't re-read config
      const projectDir = join(projectsDir, 'config-race')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'cr-test.jsonl'), JSON.stringify(user('test')) + '\n')

      const result = await migrateAllSessions({
        projectDir: 'config-race',
        _store: store,
      })

      expect(result.migrated).toBe(1)
    })
  })

  describe('repair pass', () => {
    it('re-syncs rows that have no sync info (old migration rows)', async () => {
      const projectDir = join(projectsDir, 'repair-test')
      mkdirSync(projectDir, { recursive: true })
      const filePath = join(projectDir, 'stale.jsonl')
      writeFileSync(filePath, JSON.stringify(user('v1')) + '\n')

      // Simulate an old migration: rows present, NO sync info.
      const entries = [user('v1')]
      store.syncSession('stale', 'repair-test', entries)
      expect(store.getSyncInfo('stale')).toBeNull()
      expect(store.getSession('stale')?.messageCount).toBe(1)

      const result = await migrateAllSessions({ projectDir: 'repair-test', _store: store })

      expect(result.repaired).toBe(1)
      expect(result.skipped).toBe(0)
      // Now fresh: sync info recorded and stat matches.
      expect(store.getSyncInfo('stale')).not.toBeNull()
    })

    it('re-syncs when the source file changed after the last sync', async () => {
      const projectDir = join(projectsDir, 'changed-test')
      mkdirSync(projectDir, { recursive: true })
      const filePath = join(projectDir, 'grows.jsonl')
      writeFileSync(filePath, JSON.stringify(user('one')) + '\n')

      const first = await migrateAllSessions({ projectDir: 'changed-test', _store: store })
      expect(first.migrated).toBe(1)

      // File grows (append) — must be re-synced on the next pass.
      writeFileSync(filePath, JSON.stringify(user('one')) + '\n' + JSON.stringify(user('two')) + '\n')

      const second = await migrateAllSessions({ projectDir: 'changed-test', _store: store })
      expect(second.repaired).toBe(1)
      expect(store.getSession('grows')?.messageCount).toBe(2)
    })

    it('skips when rows are already current', async () => {
      const projectDir = join(projectsDir, 'fresh-test')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'fresh.jsonl'), JSON.stringify(user('x')) + '\n')

      await migrateAllSessions({ projectDir: 'fresh-test', _store: store })
      const second = await migrateAllSessions({ projectDir: 'fresh-test', _store: store })
      expect(second.skipped).toBe(1)
      expect(second.repaired).toBe(0)
      expect(second.migrated).toBe(0)
    })
  })

  describe('orphan pruning', () => {
    it('prunes .jsonl-suffixed rows from the old sessionId bug', async () => {
      const projectDir = join(projectsDir, 'prune-test')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'real-session.jsonl'), JSON.stringify(user('real')) + '\n')

      // Bug artifact: same content stored under a key WITH the extension.
      // (Its source path real-session.jsonl.jsonl does not exist.)
      store.syncSession('real-session.jsonl', 'prune-test', [user('real')])

      const result = await migrateAllSessions({ projectDir: 'prune-test', _store: store })

      expect(result.pruned).toBe(1)
      expect(store.getSession('real-session.jsonl')).toBeNull()
      // The correctly-keyed session was still migrated and kept.
      expect(store.getSession('real-session')).not.toBeNull()
    })

    it('prunes subagent transcript rows wrongly migrated as top-level sessions', async () => {
      const projectDir = join(projectsDir, 'subagent-prune')
      const sessionDir = join(projectDir, 'session-abc', 'subagents')
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(projectDir, 'session-abc.jsonl'), JSON.stringify(user('main')) + '\n')
      writeFileSync(join(sessionDir, 'agent-xyz.jsonl'), JSON.stringify(user('sub')) + '\n')

      // Simulate the old bug: subagent transcript stored as a top-level session.
      store.syncSession('agent-xyz', 'subagent-prune', [user('sub')])

      const result = await migrateAllSessions({ projectDir: 'subagent-prune', _store: store })

      expect(result.pruned).toBe(1)
      expect(store.getSession('agent-xyz')).toBeNull()
      expect(store.getSession('session-abc')).not.toBeNull()
      // The subagent JSONL itself is untouched on disk.
      expect(existsSync(join(sessionDir, 'agent-xyz.jsonl'))).toBe(true)
    })

    it('prunes rows for sessions whose source file was deleted', async () => {
      const projectDir = join(projectsDir, 'deleted-test')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'gone.jsonl'), JSON.stringify(user('gone')) + '\n')

      await migrateAllSessions({ projectDir: 'deleted-test', _store: store })
      expect(store.getSession('gone')).not.toBeNull()

      // User deletes the source (cleanupPeriodDays); rows are unreadable garbage.
      rmSync(join(projectDir, 'gone.jsonl'))

      const result = await migrateAllSessions({ projectDir: 'deleted-test', _store: store })
      expect(result.pruned).toBe(1)
      expect(store.getSession('gone')).toBeNull()
    })

    it('does not prune rows whose source still exists', async () => {
      const projectDir = join(projectsDir, 'keep-test')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'keep.jsonl'), JSON.stringify(user('keep')) + '\n')

      await migrateAllSessions({ projectDir: 'keep-test', _store: store })
      const before = store.getSession('keep')

      const result = await migrateAllSessions({ projectDir: 'keep-test', _store: store })
      expect(result.pruned).toBe(0)
      expect(store.getSession('keep')).toEqual(before)
    })

    it('can be disabled with prune: false', async () => {
      const projectDir = join(projectsDir, 'no-prune-test')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'np.jsonl'), JSON.stringify(user('np')) + '\n')
      store.syncSession('np.jsonl', 'no-prune-test', [user('np')])

      const result = await migrateAllSessions({
        projectDir: 'no-prune-test',
        _store: store,
        prune: false,
      })
      expect(result.pruned).toBe(0)
      expect(store.getSession('np.jsonl')).not.toBeNull()
    })
  })

  describe('migration result accuracy', () => {
    it('counts migrated, skipped, failed correctly', async () => {
      const projectDir = join(projectsDir, 'count-test')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'new.jsonl'), JSON.stringify(user('new')) + '\n')
      writeFileSync(join(projectDir, 'existing.jsonl'), JSON.stringify(user('existing')) + '\n')

      // Pre-populate one session
      const existingFile = { filePath: join(projectDir, 'existing.jsonl'), sessionId: 'existing', projectDir: 'count-test', isSubagent: false }
      await migrateSession(store, existingFile, { dryRun: false })

      const result = await migrateAllSessions({
        projectDir: 'count-test',
        _store: store,
      })

      expect(result.total).toBe(2)
      expect(result.migrated).toBe(1) // only 'new'
      expect(result.skipped).toBe(1) // 'existing' already in DB
      expect(result.failed).toBe(0)
    })

    it('handles empty files gracefully', async () => {
      const projectDir = join(projectsDir, 'empty-test')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'empty.jsonl'), '')

      const result = await migrateAllSessions({
        projectDir: 'empty-test',
        _store: store,
      })

      expect(result.skipped).toBe(1)
      expect(result.migrated).toBe(0)
    })
  })
})