/**
 * Item ③ — DB-first batch analytics (/insights + stats).
 *
 * The analytics readers used to walk the projects tree; with D4 deferring the
 * export (or the tree being deleted) that would silently lose data. These
 * tests pin the row-sourced behavior: rows are the source when they are
 * primary-owned or the file is missing, and the file is the fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionStore,
  __resetSessionStoreForTests,
  getSessionStore,
} from './SessionStore.js'
import {
  shadowAppendBatch,
  flushShadowWrites,
  __setShadowStoreForTests,
  __resetShadowWriterForTests,
} from './shadowWriter.js'
import type { Entry } from '../../types/logs.js'

const S1 = '00000000-0000-4000-8000-0000000000c1'

function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function user(n: number, parent: string | null, content: string, ts: number): Entry {
  return {
    parentUuid: parent,
    isSidechain: false,
    uuid: uid(n),
    timestamp: new Date(ts).toISOString(),
    type: 'user',
    sessionId: S1,
    cwd: '/proj',
    message: { role: 'user', content },
  } as unknown as Entry
}

function assistant(n: number, parent: string, ts: number): Entry {
  return {
    parentUuid: parent,
    isSidechain: false,
    uuid: uid(n),
    timestamp: new Date(ts).toISOString(),
    type: 'assistant',
    sessionId: S1,
    cwd: '/proj',
    message: {
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  } as unknown as Entry
}

describe('batch analytics DB-first (item 3)', () => {
  let dir: string
  let store: SessionStore
  let jsonl: string
  const now = Date.now()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'analytics-db-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.CODEV_DB_PRIMARY = '1'
    process.env.TEST_ENABLE_SHADOW_WRITER = '1'
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    mkdirSync(join(dir, 'projects', 'proj'), { recursive: true })
    jsonl = join(dir, 'projects', 'proj', `${S1}.jsonl`)

    __resetSessionStoreForTests()
    store = getSessionStore()
    __setShadowStoreForTests(store)
    __resetShadowWriterForTests()
  })

  afterEach(() => {
    __setShadowStoreForTests(null)
    __resetShadowWriterForTests()
    __resetSessionStoreForTests()
    delete process.env.CODEV_DB_PRIMARY
    delete process.env.TEST_ENABLE_SHADOW_WRITER
    delete process.env.TEST_ENABLE_TRANSCRIPT_CACHE
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  async function mirror(entries: Entry[]): Promise<void> {
    shadowAppendBatch(jsonl, entries, 1)
    await flushShadowWrites()
  }

  it('aggregateClaudeCodeStatsForRange counts rows-only sessions', async () => {
    await mirror([
      user(1, null, 'hello', now - 60_000),
      assistant(2, uid(1), now - 30_000),
      user(3, uid(2), 'more', now),
    ])
    // No export file at all — the rows are the only copy.
    expect(existsSync(jsonl)).toBe(false)

    const { aggregateClaudeCodeStatsForRange } = await import('../../utils/stats.js')
    const stats = await aggregateClaudeCodeStatsForRange('7d')
    expect(stats.totalMessages).toBe(3)
    expect(stats.totalSessions).toBe(1)
    expect(stats.modelUsage['claude-test']).toBeDefined()
  })

  it('insights loader serves rows when the export file is gone', async () => {
    await mirror([user(1, null, 'hello', now - 60_000), assistant(2, uid(1), now)])
    expect(store.isSessionPrimaryOwned(S1)).toBe(true)

    const { loadAllLogsFromSessionFile } = await import('../../utils/sessionStorage.js')
    const logs = await loadAllLogsFromSessionFile(jsonl)
    expect(logs.length).toBeGreaterThan(0)
    const messages = logs[0]!.messages
    expect(messages.length).toBe(2)
    expect(messages[0]!.uuid).toBe(uid(1))
  })

  it('insights loader matches the file result for a legacy (unmarked) file', async () => {
    // A file written outside the mirror: unmarked rows + a present file.
    const entries = [
      user(1, null, 'legacy', now - 60_000),
      assistant(2, uid(1), now),
    ]
    writeFileSync(jsonl, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

    const { loadAllLogsFromSessionFile } = await import('../../utils/sessionStorage.js')
    // Gate off → pure file read (the baseline).
    delete process.env.TEST_ENABLE_TRANSCRIPT_CACHE
    const fromFile = await loadAllLogsFromSessionFile(jsonl)
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'

    const fromDb = await loadAllLogsFromSessionFile(jsonl)
    expect(fromDb.length).toBe(fromFile.length)
    expect(fromDb[0]!.messages.map(m => m.uuid)).toEqual(
      fromFile[0]!.messages.map(m => m.uuid),
    )
  })

  it('insights scan lists main sessions from rows with the tree deleted', async () => {
    await mirror([user(1, null, 'main session', now)])
    // A subagent transcript must not become a session entry.
    const subPath = join(dir, 'projects', 'proj', S1, 'subagents', 'agent-zz9.jsonl')
    mkdirSync(join(dir, 'projects', 'proj', S1, 'subagents'), { recursive: true })
    shadowAppendBatch(subPath, [user(2, null, 'sub', now)], 1)
    await flushShadowWrites()

    // Remove the whole projects tree — only rows remain.
    rmSync(join(dir, 'projects'), { recursive: true, force: true })

    const { scanAllSessions } = await import('../../commands/insights.js')
    const sessions = await scanAllSessions()
    expect(sessions.map(s => s.sessionId)).toEqual([S1])
    expect(sessions[0]!.path).toBe(jsonl)
  })
})
