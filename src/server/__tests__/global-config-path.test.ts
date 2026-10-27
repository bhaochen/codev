import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleCliAuthApi } from '../api/cli-auth.js'
import { readCliAuthProvider } from '../api/models.js'
import { __resetSessionStoreForTests } from '../../services/db/SessionStore.js'

// The desktop server reads and writes the CLI auth provider document stored
// in codev.db (app_documents namespace 'config', key 'global'). These tests
// confirm that the PUT → GET round-trip works and that readCliAuthProvider
// reflects the stored document.

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

let scratchDir: string

beforeEach(() => {
  // Point the data root at a fresh scratch directory so tests never touch the
  // real user's codev.db, and drop the singleton so each test re-opens it.
  scratchDir = mkdtempSync(join(tmpdir(), 'codev-test-db-'))
  process.env.CODEV_DATA_DIR = scratchDir
  __resetSessionStoreForTests()
})

afterEach(() => {
  __resetSessionStoreForTests()
  delete process.env.CODEV_DATA_DIR
  rmSync(scratchDir, { recursive: true, force: true })
})

describe('server reads/writes the CLI global config document in codev.db', () => {
  test('PUT persists and GET reads back the auth provider', async () => {
    await putCliAuth({ authProvider: 'opencode', openCodeApiKey: 'key-123' })
    expect(await getCliAuth()).toMatchObject({
      authProvider: 'opencode',
      openCodeApiKey: 'key-123',
    })
    // And the CLI-side reader used by the models API sees it too.
    expect(await readCliAuthProvider()).toMatchObject({
      authProvider: 'opencode',
    })
  })

  test('GET falls back to authProvider null when no document exists', async () => {
    // A fresh store has no 'config/global' document.
    expect(await getCliAuth()).toMatchObject({ authProvider: null })
  })
})
