/**
 * SessionStore tests — verify SQLite-backed session storage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './SessionStore.js'
import type { Entry } from '../../types/logs.js'

describe('SessionStore', () => {
  let store: SessionStore
  let dbPath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'codev-session-store-test-'))
    dbPath = join(dir, 'test.sqlite')
    store = SessionStore.open(dbPath)
  })

  afterEach(() => {
    store.close()
    // Cleanup handled by OS tmpdir
  })

  describe('Session CRUD', () => {
    it('should create and retrieve a session', () => {
      store.createSession({
        id: 'test-session-1',
        projectDir: '/test/project',
        title: 'Test Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const session = store.getSession('test-session-1')
      expect(session).not.toBeNull()
      expect(session!.id).toBe('test-session-1')
      expect(session!.title).toBe('Test Session')
      expect(session!.projectDir).toBe('/test/project')
    })

    it('should return null for non-existent session', () => {
      const session = store.getSession('non-existent')
      expect(session).toBeNull()
    })

    it('should update session metadata', () => {
      store.createSession({
        id: 'test-session-2',
        projectDir: '/test/project',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      store.updateSession('test-session-2', { title: 'Updated Title' })

      const session = store.getSession('test-session-2')
      expect(session!.title).toBe('Updated Title')
    })

    it('should list sessions ordered by updated_at', () => {
      const now = Date.now()
      store.createSession({
        id: 'session-a',
        projectDir: '/test/project',
        createdAt: now - 1000,
        updatedAt: now - 1000,
      })
      store.createSession({
        id: 'session-b',
        projectDir: '/test/project',
        createdAt: now,
        updatedAt: now,
      })

      const sessions = store.listSessions()
      expect(sessions.length).toBe(2)
      expect(sessions[0].id).toBe('session-b')
      expect(sessions[1].id).toBe('session-a')
    })

    it('should filter sessions by project directory', () => {
      store.createSession({
        id: 'session-a',
        projectDir: '/project/a',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      store.createSession({
        id: 'session-b',
        projectDir: '/project/b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const sessions = store.listSessions({ projectDir: '/project/a' })
      expect(sessions.length).toBe(1)
      expect(sessions[0].id).toBe('session-a')
    })

    it('should delete session and its messages', () => {
      store.createSession({
        id: 'test-session-3',
        projectDir: '/test/project',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const entry: Entry = {
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        uuid: 'uuid-1',
        parentUuid: null,
        timestamp: new Date().toISOString(),
        sessionId: 'test-session-3',
        cwd: '/test/project',
        isSidechain: false,
      }

      store.appendMessage('test-session-3', entry)
      expect(store.getMessageCount('test-session-3')).toBe(1)

      store.deleteSession('test-session-3')
      expect(store.getSession('test-session-3')).toBeNull()
      expect(store.getMessageCount('test-session-3')).toBe(0)
    })
  })

  describe('Message Operations', () => {
    beforeEach(() => {
      store.createSession({
        id: 'msg-test-session',
        projectDir: '/test/project',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    })

    it('should append and retrieve messages', () => {
      const entry: Entry = {
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        uuid: 'uuid-1',
        parentUuid: null,
        timestamp: new Date().toISOString(),
        sessionId: 'msg-test-session',
        cwd: '/test/project',
        isSidechain: false,
      }

      store.appendMessage('msg-test-session', entry)

      const messages = store.getMessages({ sessionId: 'msg-test-session' })
      expect(messages.length).toBe(1)
      expect(messages[0].data.type).toBe('user')
      expect(messages[0].uuid).toBe('uuid-1')
    })

    it('should batch append messages', () => {
      const entries: Entry[] = [
        {
          type: 'user',
          message: { role: 'user', content: 'Hello' },
          uuid: 'uuid-1',
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId: 'msg-test-session',
          cwd: '/test/project',
          isSidechain: false,
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
          uuid: 'uuid-2',
          parentUuid: 'uuid-1',
          timestamp: new Date().toISOString(),
          sessionId: 'msg-test-session',
          cwd: '/test/project',
          isSidechain: false,
        },
      ]

      store.appendMessages('msg-test-session', entries)

      expect(store.getMessageCount('msg-test-session')).toBe(2)
    })

    it('should paginate messages', () => {
      const entries: Entry[] = Array.from({ length: 10 }, (_, i) => ({
        type: 'user' as const,
        message: { role: 'user' as const, content: `Message ${i}` },
        uuid: `uuid-${i}`,
        parentUuid: i > 0 ? `uuid-${i - 1}` : null,
        timestamp: new Date().toISOString(),
        sessionId: 'msg-test-session',
        cwd: '/test/project',
        isSidechain: false,
      }))

      store.appendMessages('msg-test-session', entries)

      const page1 = store.getMessages({ sessionId: 'msg-test-session', limit: 3 })
      expect(page1.length).toBe(3)

      const page2 = store.getMessages({ sessionId: 'msg-test-session', limit: 3, afterSeq: page1[2].seq })
      expect(page2.length).toBe(3)
      expect(page2[0].seq).toBeGreaterThan(page1[2].seq)
    })

    it('should filter messages by entry type', () => {
      const entries: Entry[] = [
        {
          type: 'user',
          message: { role: 'user', content: 'Hello' },
          uuid: 'uuid-1',
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId: 'msg-test-session',
          cwd: '/test/project',
          isSidechain: false,
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
          uuid: 'uuid-2',
          parentUuid: 'uuid-1',
          timestamp: new Date().toISOString(),
          sessionId: 'msg-test-session',
          cwd: '/test/project',
          isSidechain: false,
        },
        {
          type: 'custom-title',
          customTitle: 'My Session',
          sessionId: 'msg-test-session',
        },
      ]

      store.appendMessages('msg-test-session', entries)

      const userMessages = store.getMessages({ sessionId: 'msg-test-session', entryTypes: ['user'] })
      expect(userMessages.length).toBe(1)
      expect(userMessages[0].data.type).toBe('user')
    })

    it('should update message count on append', () => {
      expect(store.getMessageCount('msg-test-session')).toBe(0)

      const entry: Entry = {
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        uuid: 'uuid-1',
        parentUuid: null,
        timestamp: new Date().toISOString(),
        sessionId: 'msg-test-session',
        cwd: '/test/project',
        isSidechain: false,
      }

      store.appendMessage('msg-test-session', entry)
      expect(store.getMessageCount('msg-test-session')).toBe(1)

      store.appendMessage('msg-test-session', { ...entry, uuid: 'uuid-2' })
      expect(store.getMessageCount('msg-test-session')).toBe(2)
    })
  })

  describe('Conversation Chain', () => {
    it('should retrieve conversation chain', () => {
      const entries: Entry[] = [
        {
          type: 'user',
          message: { role: 'user', content: 'Hello' },
          uuid: 'uuid-1',
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId: 'msg-test-session',
          cwd: '/test/project',
          isSidechain: false,
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
          uuid: 'uuid-2',
          parentUuid: 'uuid-1',
          timestamp: new Date().toISOString(),
          sessionId: 'msg-test-session',
          cwd: '/test/project',
          isSidechain: false,
        },
      ]

      store.appendMessages('msg-test-session', entries)

      const chain = store.getConversationChain('msg-test-session')
      expect(chain.length).toBe(2)
      expect(chain[0].type).toBe('user')
      expect(chain[1].type).toBe('assistant')
    })
  })
})
