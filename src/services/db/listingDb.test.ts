/**
 * Phase C1 — DB-first listing differential tests.
 *
 * loadMessageLogs() must produce identical enriched listings whether the
 * metadata comes from the JSONL head/tail scan (fallback) or from the session
 * row (DB-first). The DB path must also never serve stale data: any
 * divergence between the row and the live file falls back to the file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  loadAllProjectsMessageLogs,
  loadMessageLogs,
} from '../../utils/sessionStorage.js'
import { loadTranscriptCached } from './transcriptCache.js'
import {
  __resetSessionStoreForTests,
  getSessionStore,
} from './SessionStore.js'
import { getProjectDir, getProjectsDir } from '../../utils/sessionStoragePortable.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import type { Entry } from '../../types/logs.js'

const S = '00000000-0000-4000-8000-0000000000d1'

function user(prompt: string, extra: Record<string, unknown> = {}): Entry {
  return {
    type: 'user',
    sessionId: S,
    uuid: '00000000-0000-4000-8000-000000000001',
    parentUuid: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/proj',
    gitBranch: 'main',
    message: { role: 'user', content: prompt },
    ...extra,
  } as unknown as Entry
}

/** Fields the picker displays — the enrichment surface under test. */
function pick(log: Awaited<ReturnType<typeof loadMessageLogs>>[number]) {
  return {
    sessionId: log.sessionId,
    firstPrompt: log.firstPrompt,
    customTitle: log.customTitle,
    tag: log.tag,
    gitBranch: log.gitBranch,
    prNumber: log.prNumber,
    prUrl: log.prUrl,
    prRepository: log.prRepository,
    agentSetting: log.agentSetting,
    summary: log.summary,
    projectPath: log.projectPath,
    isSidechain: log.isSidechain,
  }
}

describe('DB-first listing (Phase C1)', () => {
  let dir: string
  let projectsProjectDir: string
  let jsonl: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'listing-db-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    __resetSessionStoreForTests()

    // fetchLogs scans getProjectDir(getOriginalCwd()) — place the fixture there.
    projectsProjectDir = getProjectDir(getOriginalCwd())
    mkdirSync(projectsProjectDir, { recursive: true })
    jsonl = join(projectsProjectDir, `${S}.jsonl`)

    const entries: Entry[] = [
      user('hello world'),
      {
        type: 'custom-title',
        customTitle: 'My Session',
        sessionId: S,
      } as unknown as Entry,
      { type: 'tag', tag: '#dev', sessionId: S } as unknown as Entry,
      {
        type: 'agent-setting',
        agentSetting: 'normal',
        sessionId: S,
      } as unknown as Entry,
      {
        type: 'pr-link',
        prNumber: 42,
        prUrl: 'https://example.com/pr/42',
        prRepository: 'org/repo',
        sessionId: S,
      } as unknown as Entry,
      {
        type: 'last-prompt',
        lastPrompt: 'hello world',
        sessionId: S,
      } as unknown as Entry,
    ]
    writeFileSync(jsonl, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  })

  afterEach(() => {
    __resetSessionStoreForTests()
    delete process.env.TEST_ENABLE_TRANSCRIPT_CACHE
    delete process.env.CODEV_DB_PRIMARY
    delete process.env.CLAUDE_CONFIG_DIR
    // Ensure cleanup can remove a chmod-000 file.
    try {
      chmodSync(jsonl, 0o600)
    } catch {
      /* file may be gone */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('file-fallback listing produces the expected enrichment', async () => {
    const logs = await loadMessageLogs()
    expect(logs).toHaveLength(1)
    expect(pick(logs[0]!)).toEqual({
      sessionId: S,
      firstPrompt: 'hello world',
      customTitle: 'My Session',
      tag: '#dev',
      gitBranch: 'main',
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
      prRepository: 'org/repo',
      agentSetting: 'normal',
      summary: undefined,
      projectPath: '/proj',
      isSidechain: false,
    })
  })

  it('DB-first listing is identical to the file-fallback listing', async () => {
    const baseline = await loadMessageLogs()

    // Sync the session into the DB (this is what shadow writes / migration do).
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    const store = getSessionStore()
    const relProject = relative(getProjectsDir(), projectsProjectDir)
    await loadTranscriptCached(store, S, jsonl, relProject)

    const fromDb = await loadMessageLogs()
    expect(fromDb).toHaveLength(1)
    expect(pick(fromDb[0]!)).toEqual(pick(baseline[0]!))
  })

  it('DB-first path really is used (file unreadable, listing still enriched)', async () => {
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    const store = getSessionStore()
    const relProject = relative(getProjectsDir(), projectsProjectDir)
    await loadTranscriptCached(store, S, jsonl, relProject)

    // Make the file unreadable for the fallback scan; only the DB path can
    // still produce enriched metadata.
    chmodSync(jsonl, 0o000)
    const logs = await loadMessageLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.firstPrompt).toBe('hello world')
    expect(logs[0]!.customTitle).toBe('My Session')
    chmodSync(jsonl, 0o600)
  })

  it('stale DB (file changed after sync) falls back to the file', async () => {
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    const store = getSessionStore()
    const relProject = relative(getProjectsDir(), projectsProjectDir)
    await loadTranscriptCached(store, S, jsonl, relProject)

    // The file gains a newer last-prompt after the sync.
    appendFileSync(
      jsonl,
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'newer prompt', sessionId: S }) + '\n',
    )

    const logs = await loadMessageLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.firstPrompt).toBe('newer prompt')
  })

  it('legacy row without lastPrompt derives the first prompt from stored rows', async () => {
    // Rewrite the file WITHOUT a last-prompt entry (legacy shape).
    const legacy: Entry[] = [
      user('legacy first prompt'),
      { type: 'custom-title', customTitle: 'Legacy', sessionId: S } as unknown as Entry,
    ]
    writeFileSync(jsonl, legacy.map(e => JSON.stringify(e)).join('\n') + '\n')

    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    process.env.CODEV_DB_PRIMARY = '1'
    const store = getSessionStore()
    const relProject = relative(getProjectsDir(), projectsProjectDir)
    await loadTranscriptCached(store, S, jsonl, relProject)

    const logs = await loadMessageLogs()
    expect(logs).toHaveLength(1)
    // No last-prompt was stored, so the prompt is recovered from the rows.
    expect(logs[0]!.firstPrompt).toBe('legacy first prompt')
    expect(logs[0]!.customTitle).toBe('Legacy')
  })

  it('serves a listing when the export file is deleted (rows are the only copy)', async () => {
    // Legacy shape: no last-prompt entry, so the title must come from rows.
    const legacy: Entry[] = [
      user('deleted-file prompt'),
      { type: 'tag', tag: '#keep', sessionId: S } as unknown as Entry,
    ]
    writeFileSync(jsonl, legacy.map(e => JSON.stringify(e)).join('\n') + '\n')

    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    process.env.CODEV_DB_PRIMARY = '1'
    const store = getSessionStore()
    const relProject = relative(getProjectsDir(), projectsProjectDir)
    await loadTranscriptCached(store, S, jsonl, relProject)

    // Deferred export (D4): the file may never be materialized or may be pruned.
    rmSync(jsonl)

    const logs = await loadMessageLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.sessionId).toBe(S)
    expect(logs[0]!.firstPrompt).toBe('deleted-file prompt')
    expect(logs[0]!.tag).toBe('#keep')
  })

  it('enumerates projects from the DB when the projects tree is gone', async () => {
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    process.env.CODEV_DB_PRIMARY = '1'
    const store = getSessionStore()
    const relProject = relative(getProjectsDir(), projectsProjectDir)
    await loadTranscriptCached(store, S, jsonl, relProject)

    // Drop the whole project directory: readdir(getProjectsDir()) can no longer
    // discover it, so only the DB rows can supply the directory name.
    rmSync(projectsProjectDir, { recursive: true, force: true })

    const logs = await loadAllProjectsMessageLogs()
    const found = logs.find(l => l.sessionId === S)
    expect(found).toBeDefined()
    expect(found!.firstPrompt).toBe('hello world')
  })

  it('listCandidates enumerates rows when the project dir is gone', async () => {
    process.env.TEST_ENABLE_TRANSCRIPT_CACHE = '1'
    process.env.CODEV_DB_PRIMARY = '1'
    const store = getSessionStore()
    const relProject = relative(getProjectsDir(), projectsProjectDir)
    await loadTranscriptCached(store, S, jsonl, relProject)

    rmSync(projectsProjectDir, { recursive: true, force: true })

    const { listCandidates } = await import('../../utils/listSessionsImpl.js')
    const candidates = await listCandidates(
      getProjectDir(getOriginalCwd()),
      true,
      getOriginalCwd(),
    )
    expect(candidates.map(c => c.sessionId)).toContain(S)
  })
})
