import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleCliAuthApi } from '../api/cli-auth.js'
import { readCliAuthProvider } from '../api/models.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import {
  LEGACY_GLOBAL_CONFIG_FILENAME,
  resolveGlobalConfigFilePath,
} from '../../utils/globalConfigPath.js'

// Proves the desktop server reads and writes the exact file the CLI resolves,
// under every path-affecting environment combination.
const RELEVANT_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'USER_TYPE',
  'USE_LOCAL_OAUTH',
  'USE_STAGING_OAUTH',
] as const

let savedEnv: Record<string, string | undefined>
let configDir: string
const tmpDirs: string[] = []

beforeEach(() => {
  savedEnv = {}
  for (const key of RELEVANT_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'server-global-config-'))
  tmpDirs.push(configDir)
  process.env.CLAUDE_CONFIG_DIR = configDir
  getGlobalClaudeFile.cache.clear()
})

afterEach(() => {
  for (const key of RELEVANT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  getGlobalClaudeFile.cache.clear()
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const BASE = 'http://localhost/api/cli-auth'
const SEGMENTS = ['api', 'cli-auth']

async function getCliAuth(): Promise<Record<string, unknown>> {
  const res = await handleCliAuthApi(new Request(BASE), new URL(BASE), SEGMENTS)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

async function putCliAuth(body: Record<string, unknown>): Promise<void> {
  const res = await handleCliAuthApi(
    new Request(BASE, { method: 'PUT', body: JSON.stringify(body) }),
    new URL(BASE),
    SEGMENTS,
  )
  expect(res.status).toBe(200)
  const json = (await res.json()) as { ok?: boolean }
  expect(json.ok).toBe(true)
}

describe('server reads/writes the CLI global config file', () => {
  test('server path resolution matches the CLI', () => {
    expect(resolveGlobalConfigFilePath()).toBe(getGlobalClaudeFile())
    expect(getGlobalClaudeFile()).toBe(join(configDir, '.claude.json'))
  })

  test('PUT goes to the CLI file and GET reads it back', async () => {
    await putCliAuth({ authProvider: 'opencode', openCodeApiKey: 'key-123' })

    // The write landed on the exact path the CLI resolves — not on
    // <configDir>/.claude/.claude.json (the historical server bug).
    const cliFile = getGlobalClaudeFile()
    expect(existsSync(cliFile)).toBe(true)
    expect(JSON.parse(readFileSync(cliFile, 'utf8'))).toMatchObject({
      authProvider: 'opencode',
      openCodeApiKey: 'key-123',
    })
    expect(existsSync(join(configDir, '.claude', '.claude.json'))).toBe(false)

    expect(await getCliAuth()).toMatchObject({
      authProvider: 'opencode',
      openCodeApiKey: 'key-123',
    })
    // And the CLI-side reader used by the models API sees it too.
    expect(await readCliAuthProvider()).toMatchObject({
      authProvider: 'opencode',
    })
  })

  test('GET falls back to authProvider null when the file is absent', async () => {
    expect(await getCliAuth()).toEqual({ authProvider: null })
    expect(await readCliAuthProvider()).toBeNull()
  })

  test('reads the legacy <home>/.config.json when it exists', async () => {
    const legacy = join(configDir, LEGACY_GLOBAL_CONFIG_FILENAME)
    writeFileSync(legacy, JSON.stringify({ authProvider: 'nvidia' }))

    expect(resolveGlobalConfigFilePath()).toBe(legacy)
    expect(await readCliAuthProvider()).toEqual({ authProvider: 'nvidia' })
    expect(await getCliAuth()).toMatchObject({ authProvider: 'nvidia' })
  })

  test('honors the OAuth filename suffix on both sides', async () => {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'http://localhost:1234'
    getGlobalClaudeFile.cache.clear()

    const expected = join(configDir, '.claude-custom-oauth.json')
    expect(resolveGlobalConfigFilePath()).toBe(expected)
    expect(getGlobalClaudeFile()).toBe(expected)

    await putCliAuth({ authProvider: 'openrouter' })
    expect(JSON.parse(readFileSync(expected, 'utf8'))).toMatchObject({
      authProvider: 'openrouter',
    })
    expect(await readCliAuthProvider()).toEqual({ authProvider: 'openrouter' })
  })
})
