/**
 * Item 2 — subagent transcript mirroring tests.
 *
 * Subagent transcripts (`<proj>/<sid>/subagents/agent-*.jsonl`) get their own
 * DB rows under composite ids (`<sid>/subagents/[.../]agent-*`, kind
 * 'subagent', parent_session_id linked). Reads (getAgentTranscript) serve
 * from the rows; listings exclude them; the migration scanner finds them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  SessionStore,
  __resetSessionStoreForTests,
  getSessionStore,
} from './SessionStore.js'
import {
  flushShadowWrites,
  shadowAppendBatch,
  __setShadowStoreForTests,
  __resetShadowWriterForTests,
} from './shadowWriter.js'
import { findSessionFiles, migrateAllSessions } from './migrateSessions.js'
import type { Entry } from '../../types/logs.js'

const PARENT = '00000000-0000-4000-8000-0000000000b1'
const AGENT = 'abc123'
const SID = `${PARENT}/subagents/agent-${AGENT}`

function sidechain(n: number, parent: string | null, content: string): Entry {
  return {
    parentUuid: parent,
    isSidechain: true,
    uuid: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    timestamp: new Date(1700000000000 + n).toISOString(),
    type: 'user',
    sessionId: PARENT,
    agentId: AGENT,
    message: { role: 'user', content },
  } as unknown as Entry
}

function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

describe('subagent transcript mirroring (item 2)', () => {
  let dir: string
  let store: SessionStore
  let agentFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'subagent-mirror-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.CODEV_DB_PRIMARY = '1'
    process.env.TEST_ENABLE_SHADOW_WRITER = '1'
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'

    mkdirSync(join(dir, 'projects', 'proj', PARENT, 'subagents'), { recursive: true })
    agentFile = join(dir, 'projects', 'proj', PARENT, 'subagents', `agent-${AGENT}.jsonl`)

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

  it('mirrors subagent appends under the composite id with kind/parent', async () => {
    const line = JSON.stringify(sidechain(1, null, 'subagent says hi')) + '\n'
    writeFileSync(agentFile, line)
    shadowAppendBatch(agentFile, [sidechain(1, null, 'subagent says hi')], Buffer.byteLength(line))
    await flushShadowWrites()

    const row = store.getSession(SID)
    expect(row).not.toBeNull()
    expect(row?.kind).toBe('subagent')
    expect(row?.parentSessionId).toBe(PARENT)
    expect(row?.messageCount).toBe(1)
    expect(store.isSessionPrimaryOwned(SID)).toBe(true)
  })

  it('listings (kind=main supplement) exclude subagent rows', async () => {
    const line = JSON.stringify(sidechain(1, null, 'x')) + '\n'
    writeFileSync(agentFile, line)
    shadowAppendBatch(agentFile, [sidechain(1, null, 'x')], Buffer.byteLength(line))
    await flushShadowWrites()

    // File deleted so ONLY the DB supplement could surface it.
    rmSync(agentFile)
    const metas = store.listSessions({
      projectDir: 'proj',
      kind: 'main',
      limit: Number.MAX_SAFE_INTEGER,
    })
    expect(metas.find(m => m.id === SID)).toBeUndefined()
    const all = store.listSessions({
      projectDir: 'proj',
      limit: Number.MAX_SAFE_INTEGER,
    })
    expect(all.find(m => m.id === SID)).toBeDefined()
  })

  it('migration scanner finds subagent files with composite ids', async () => {
    mkdirSync(join(dir, 'projects', 'proj2-scan'), { recursive: true })
    writeFileSync(
      join(dir, 'projects', 'proj2-scan', `${PARENT}.jsonl`),
      JSON.stringify(sidechain(1, null, 'main')) + '\n',
    )
    const scanSubDir = join(dir, 'projects', 'proj2-scan', PARENT, 'subagents')
    mkdirSync(scanSubDir, { recursive: true })
    writeFileSync(
      join(scanSubDir, `agent-${AGENT}.jsonl`),
      JSON.stringify(sidechain(2, uid(1), 'sub')) + '\n',
    )

    const files = await findSessionFiles('proj2-scan')
    const main = files.find(f => !f.isSubagent)
    const sub = files.find(f => f.isSubagent)
    expect(main?.sessionId).toBe(PARENT)
    expect(sub?.sessionId).toBe(SID)
    expect(sub?.parentSessionId).toBe(PARENT)
    expect(sub?.projectDir).toBe('proj2-scan')
  })

  it('migrateAllSessions imports subagent files as kind=subagent rows', async () => {
    const projDir = join(dir, 'projects', 'proj3-import')
    mkdirSync(join(projDir, PARENT, 'subagents'), { recursive: true })
    writeFileSync(
      join(projDir, `${PARENT}.jsonl`),
      JSON.stringify(sidechain(1, null, 'main')) + '\n',
    )
    writeFileSync(
      join(projDir, PARENT, 'subagents', `agent-${AGENT}.jsonl`),
      JSON.stringify(sidechain(2, uid(1), 'sub')) + '\n',
    )

    const result = await migrateAllSessions({ projectDir: 'proj3-import', _store: store })
    expect(result.failed).toBe(0)
    expect(result.total).toBe(2)

    const sub = store.getSession(SID)
    expect(sub?.kind).toBe('subagent')
    expect(sub?.parentSessionId).toBe(PARENT)
    // Sync info recorded → the read gate (fresh) can serve it.
    expect(store.getSyncInfo(SID)).not.toBeNull()
    // Prune must NOT delete it (its composite path maps to the real file).
    expect(existsSync(join(projDir, PARENT, 'subagents', `agent-${AGENT}.jsonl`))).toBe(true)
  })

  it('getAgentTranscript serves from rows (file deleted) when marked', async () => {
    const sessionStorage = await import('../../utils/sessionStorage.js')
    // The real path the reader will look up — put the file exactly there.
    const realAgentFile = sessionStorage.getAgentTranscriptPath(AGENT as never)
    mkdirSync(join(realAgentFile, '..'), { recursive: true })

    const entries = [sidechain(1, null, 'hello from subagent'), sidechain(2, uid(1), 'second')]
    writeFileSync(realAgentFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
    await sessionStorage.flushSessionStorage?.() // no-op safety if unavailable
    shadowAppendBatch(realAgentFile, entries, 1)
    await flushShadowWrites()

    // Composite id WITHOUT the project-dir segment (the convention shared by
    // the writer, reader, and migration scanner).
    const relParts = relative(join(dir, 'projects'), realAgentFile).split(/[\\/]/)
    const dbId = relParts.slice(1).join('/').replace(/\.jsonl$/, '')
    expect(store.isSessionPrimaryOwned(dbId)).toBe(true)

    // File-based baseline (gate off).
    delete process.env.TEST_ENABLE_TRANSCRIPT_CACHE
    const fromFile = await sessionStorage.getAgentTranscript(AGENT as never)
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'

    // DB path with the file present must match the file result.
    const fromDb = await sessionStorage.getAgentTranscript(AGENT as never)
    expect(fromDb).toEqual(fromFile)

    // File gone: rows are the only copy — the DB path still serves it.
    rmSync(realAgentFile)
    const fromDbNoFile = await sessionStorage.getAgentTranscript(AGENT as never)
    expect(fromDbNoFile).toEqual(fromFile)
  })
})
