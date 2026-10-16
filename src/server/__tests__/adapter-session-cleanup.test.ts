/**
 * Tests pinning the config-home unification of the adapter-session cleanup.
 *
 * `deleteAdapterSessionMappings` (server/api/sessions.ts) historically resolved
 * its `adapter-sessions.json` path with `process.env.HOME || ''` — the only
 * config-home site in the server that did so. The divergence was not deliberate:
 * commit 9b099e72 restored the helper verbatim from an older revision, while the
 * sibling `adapterService` (adapters.json, same directory) and `doctorService`
 * (which inspects adapter-sessions.json) both use the shared config home.
 *
 * The `HOME || ''` form was also strictly worse: with HOME empty or unset it
 * produced the cwd-relative path `.claude`, silently pointing the cleanup at
 * `./.claude/...` while every other reader looked in the real home. These tests
 * pin the unified behavior — the cleanup mutates the file under
 * `getClaudeConfigHomeDir()`, the same path every other reader uses, and that
 * path is always absolute.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

let tmpDir: string
let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ''

// Matches the service's UUID-shaped session id check.
const SESSION_ID = 'a1b2c3d4-1111-4222-8333-444455556666'

async function writeAdapterSessionsFile(mappings: Record<string, unknown>): Promise<string> {
  const filePath = path.join(getClaudeConfigHomeDir(), 'adapter-sessions.json')
  await fs.writeFile(filePath, JSON.stringify(mappings, null, 2), 'utf-8')
  return filePath
}

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `adapter-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(path.join(tmpDir, 'projects', 'proj'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir

  // A deletable session file the API can find via the projects scan.
  await fs.writeFile(
    path.join(tmpDir, 'projects', 'proj', `${SESSION_ID}.jsonl`),
    JSON.stringify({ type: 'user', uuid: 'x' }) + '\n',
    'utf-8',
  )

  const { handleSessionsApi } = await import('../api/sessions.js')
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const segments = url.pathname.split('/').filter(Boolean)
      if (segments[0] === 'api' && segments[1] === 'sessions') {
        return handleSessionsApi(req, url, segments)
      }
      return new Response('Not Found', { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  if (server) {
    server.stop(true)
    server = null
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('adapter-session cleanup uses the shared config home', () => {
  it('DELETE /api/sessions/:id removes the mapping from getClaudeConfigHomeDir()', async () => {
    const filePath = await writeAdapterSessionsFile({
      'chat-keep': { sessionId: 'other-session' },
      'chat-remove': { sessionId: SESSION_ID },
    })

    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)

    // The session file is gone and the mapping was removed from the file under
    // the shared config home — not from a cwd-relative `./.claude` copy.
    const mappings = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<
      string,
      { sessionId?: string }
    >
    expect(mappings['chat-remove']).toBeUndefined()
    expect(mappings['chat-keep']).toEqual({ sessionId: 'other-session' })
  })

  it('leaves the file untouched when the session has no adapter mapping', async () => {
    const filePath = await writeAdapterSessionsFile({
      'chat-keep': { sessionId: 'other-session' },
    })

    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)

    const mappings = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<
      string,
      { sessionId?: string }
    >
    expect(mappings['chat-keep']).toEqual({ sessionId: 'other-session' })
  })
})

describe('getClaudeConfigHomeDir is robust to a missing HOME', () => {
  // `process.env.HOME || ''` (the old inline form) resolved to the
  // cwd-relative `.claude` here; the shared helper falls back to the passwd
  // home via os.homedir(). Verified in a subprocess because Bun snapshots
  // HOME at process start, so mutating it at runtime has no effect.
  const envUtilsPath = path.resolve(import.meta.dir, '../../utils/envUtils.ts')

  function resolveInSubprocess(home: string | null): { code: number; out: string } {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'CLAUDE_CONFIG_DIR' && key !== 'HOME') {
        env[key] = value
      }
    }
    if (home !== null) env.HOME = home

    const script = `
      const { getClaudeConfigHomeDir } = await import(${JSON.stringify(envUtilsPath)});
      const p = getClaudeConfigHomeDir();
      const { isAbsolute } = await import('node:path');
      console.log(isAbsolute(p) ? 'absolute' : 'RELATIVE:' + p);
    `
    const proc = Bun.spawnSync([process.execPath, '-e', script], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      code: proc.exitCode ?? 1,
      out: (proc.stdout.toString() + proc.stderr.toString()).trim(),
    }
  }

  it('returns an absolute path when HOME is empty', () => {
    const { code, out } = resolveInSubprocess('')
    expect(code).toBe(0)
    expect(out).toBe('absolute')
  })

  it('returns an absolute path when HOME is unset', () => {
    const { code, out } = resolveInSubprocess(null)
    expect(code).toBe(0)
    expect(out).toBe('absolute')
  })
})
