/**
 * Regression tests for resolveGroqApiKey's settings resolution.
 *
 * The settings fallback historically read `~/.claude/settings.json` via a raw
 * `homedir()` join, ignoring CLAUDE_CONFIG_DIR — while everything else in the
 * voice feature (voiceEnabled, voiceProvider, the settings env application)
 * resolves through the canonical settings API. Under a custom config dir the
 * key was therefore read from the wrong file and silently dropped. These tests
 * pin the unified behavior: the fallback reads the canonical user settings,
 * whatever CLAUDE_CONFIG_DIR points at.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettingsFilePathForSource } from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { resolveGroqApiKey } from './groqSTT.js'

const SAVED_ENV = ['CLAUDE_CONFIG_DIR', 'GROQ_API_KEY', 'CLAUDE_CODE_USE_COWORK_PLUGINS'] as const

let savedEnv: Record<string, string | undefined>
const tmpDirs: string[] = []

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'groq-stt-'))
  tmpDirs.push(dir)
  return dir
}

function writeSettings(dir: string, contents: string): void {
  writeFileSync(join(dir, 'settings.json'), contents, 'utf-8')
  // The merged settings are cached for the session — drop the cache after
  // every file/env change so the next read hits disk.
  resetSettingsCache()
}

beforeEach(() => {
  savedEnv = {}
  for (const key of SAVED_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  resetSettingsCache()
})

afterEach(() => {
  for (const key of SAVED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  resetSettingsCache()
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveGroqApiKey — settings fallback', () => {
  test('reads the settings file inside a custom CLAUDE_CONFIG_DIR', () => {
    const configDir = makeConfigDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    writeSettings(configDir, JSON.stringify({ env: { groqApiKey: 'gsk-from-config-home' } }))

    expect(resolveGroqApiKey()).toBe('gsk-from-config-home')
  })

  test('accepts the uppercase GROQ_API_KEY spelling in settings', () => {
    const configDir = makeConfigDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    writeSettings(configDir, JSON.stringify({ env: { GROQ_API_KEY: 'gsk-upper' } }))

    expect(resolveGroqApiKey()).toBe('gsk-upper')
  })

  test('returns undefined when the settings file is missing', () => {
    process.env.CLAUDE_CONFIG_DIR = makeConfigDir()

    expect(resolveGroqApiKey()).toBeUndefined()
  })

  test('returns undefined instead of throwing on malformed settings', () => {
    const configDir = makeConfigDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    writeSettings(configDir, '{ not valid json')

    expect(resolveGroqApiKey()).toBeUndefined()
  })

  test('prefers the explicit option over everything', () => {
    const configDir = makeConfigDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.GROQ_API_KEY = 'gsk-from-env'
    writeSettings(configDir, JSON.stringify({ env: { groqApiKey: 'gsk-from-settings' } }))

    expect(resolveGroqApiKey('gsk-explicit')).toBe('gsk-explicit')
  })

  test('prefers the env var over the settings file', () => {
    const configDir = makeConfigDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.GROQ_API_KEY = 'gsk-from-env'
    writeSettings(configDir, JSON.stringify({ env: { groqApiKey: 'gsk-from-settings' } }))

    expect(resolveGroqApiKey()).toBe('gsk-from-env')
  })
})

describe('default directory contract', () => {
  // The fallback must resolve to the physical home when CLAUDE_CONFIG_DIR is
  // unset — pinned via the canonical path helper so the test never reads (or
  // depends on) the developer's real settings.json. Resolving the key itself
  // in the default configuration is intentionally not tested here: it would
  // be non-hermetic.
  test('userSettings resolves to ~/.claude/settings.json by default', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
    resetSettingsCache()

    expect(getSettingsFilePathForSource('userSettings')).toBe(
      join(homedir(), '.claude', 'settings.json'),
    )
  })

  test('userSettings follows CLAUDE_CONFIG_DIR', () => {
    const configDir = makeConfigDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    resetSettingsCache()

    expect(getSettingsFilePathForSource('userSettings')).toBe(
      join(configDir, 'settings.json'),
    )
  })
})
