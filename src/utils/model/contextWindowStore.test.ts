import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushContextWindowStoreForTests,
  getStoredProviderContextWindow,
  recordProviderContextWindows,
  resetContextWindowStoreForTests,
} from './contextWindowStore.js'
import { getContextWindowForModel } from '../context.js'

describe('provider context window store', () => {
  let configDir = ''
  let previousConfigDir: string | undefined
  let previousExplicitProvider: string | undefined
  let previousBetterClawdProvider: string | undefined

  afterEach(async () => {
    resetContextWindowStoreForTests()
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    if (previousExplicitProvider === undefined) {
      delete process.env.CLAUDE_CODE_API_PROVIDER
    } else {
      process.env.CLAUDE_CODE_API_PROVIDER = previousExplicitProvider
    }
    if (previousBetterClawdProvider === undefined) {
      delete process.env.BETTER_CLAWD_API_PROVIDER
    } else {
      process.env.BETTER_CLAWD_API_PROVIDER = previousBetterClawdProvider
    }
    if (configDir) await rm(configDir, { recursive: true, force: true })
    configDir = ''
  })

  async function useTemporaryConfigDir(): Promise<void> {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'codev-context-window-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
  }

  it('persists prompt ceilings by provider and isolates identical model IDs', async () => {
    await useTemporaryConfigDir()
    recordProviderContextWindows('openrouter', [
      { id: 'Acme/Model', contextWindow: 500_000, promptLimit: 300_000 },
    ])
    recordProviderContextWindows('opencode', [
      { id: 'acme/model', contextWindow: 600_000 },
    ])
    await flushContextWindowStoreForTests()
    resetContextWindowStoreForTests()

    expect(getStoredProviderContextWindow('openrouter', 'ACME/MODEL')).toBe(300_000)
    expect(getStoredProviderContextWindow('opencode', 'acme/model')).toBe(600_000)
    expect(getStoredProviderContextWindow('nvidia', 'acme/model')).toBeUndefined()
  })

  it('does not persist local runtime windows', async () => {
    await useTemporaryConfigDir()
    recordProviderContextWindows('opencode', [
      { id: 'local-model', contextWindow: 32_000 },
    ])
    await flushContextWindowStoreForTests()

    expect(getStoredProviderContextWindow('local', 'local-model')).toBeUndefined()
  })

  it('uses persisted windows while the active provider catalog is still loading', async () => {
    await useTemporaryConfigDir()
    previousExplicitProvider = process.env.CLAUDE_CODE_API_PROVIDER
    previousBetterClawdProvider = process.env.BETTER_CLAWD_API_PROVIDER
    delete process.env.BETTER_CLAWD_API_PROVIDER
    process.env.CLAUDE_CODE_API_PROVIDER = 'openrouter'
    const model = 'sample-provider/model-startup-cache-test'
    recordProviderContextWindows('openrouter', [
      { id: model, contextWindow: 500_000, promptLimit: 250_000 },
    ])
    await flushContextWindowStoreForTests()
    resetContextWindowStoreForTests()

    expect(getContextWindowForModel(model)).toBe(250_000)
    process.env.CLAUDE_CODE_API_PROVIDER = 'nvidia'
    expect(getContextWindowForModel(model)).toBe(200_000)
  })

  it('ignores invalid or unknown cache entries', async () => {
    await useTemporaryConfigDir()
    expect(getStoredProviderContextWindow('openrouter', 'missing')).toBeUndefined()
    expect(getStoredProviderContextWindow(null, 'missing')).toBeUndefined()
    recordProviderContextWindows('openrouter', [
      { id: 'invalid', contextWindow: Number.NaN },
      { id: 'zero', contextWindow: 0 },
    ])
    await flushContextWindowStoreForTests()

    expect(getStoredProviderContextWindow('openrouter', 'invalid')).toBeUndefined()
    expect(getStoredProviderContextWindow('openrouter', 'zero')).toBeUndefined()
  })
})
