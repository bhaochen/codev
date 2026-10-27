import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalClaudeFile } from './env.js'
import {
  globalConfigFileName,
  resolveGlobalConfigFilePath,
} from './globalConfigPath.js'

// Global config is persisted in codev.db; resolveGlobalConfigFilePath is a
// stable logical identifier used by diagnostics and any code path that still
// needs a canonical path string.

const RELEVANT_ENV = [
  'CLAUDE_CONFIG_DIR',
] as const

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {}
  for (const key of RELEVANT_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  getGlobalClaudeFile.cache.clear()
})

afterEach(() => {
  for (const key of RELEVANT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  getGlobalClaudeFile.cache.clear()
})

describe('resolveGlobalConfigFilePath', () => {
  test('defaults to <codev-data-root>/config.json', () => {
    expect(resolveGlobalConfigFilePath()).toBe(join(getGlobalClaudeFile()))
  })

  test('honors CLAUDE_CONFIG_DIR as the config home', () => {
    const configDir = join(tmpdir(), 'global-config-test')
    process.env.CLAUDE_CONFIG_DIR = configDir
    expect(resolveGlobalConfigFilePath()).toBe(join(configDir, 'config.json'))
  })

  test('an explicit override takes precedence over CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'env-config-home')
    const override = join(tmpdir(), 'explicit-override')
    expect(resolveGlobalConfigFilePath(override)).toBe(
      join(override, 'config.json'),
    )
  })
})

describe('globalConfigFileName', () => {
  test('matches the production name', () => {
    expect(globalConfigFileName()).toBe('config.json')
  })
})
