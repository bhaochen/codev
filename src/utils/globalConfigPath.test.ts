import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalClaudeFile } from './env.js'
import {
  LEGACY_GLOBAL_CONFIG_FILENAME,
  globalConfigFileName,
  resolveGlobalConfigFilePath,
} from './globalConfigPath.js'

// Env vars that influence the resolved path. Snapshot/restore so these tests
// cannot leak into the rest of the suite.
const RELEVANT_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'USER_TYPE',
  'USE_LOCAL_OAUTH',
  'USE_STAGING_OAUTH',
] as const

let savedEnv: Record<string, string | undefined>
const tmpDirs: string[] = []

function makeTmpDir(prefix = 'global-config-path-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  savedEnv = {}
  for (const key of RELEVANT_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // getGlobalClaudeFile is memoized per CLAUDE_CONFIG_DIR; drop stale entries.
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

describe('resolveGlobalConfigFilePath', () => {
  test('defaults to ~/.claude.json (not ~/.claude/.claude.json)', () => {
    // On a machine that still has the legacy file, only that can win.
    const legacy = join(homedir(), '.claude', LEGACY_GLOBAL_CONFIG_FILENAME)
    const expected = existsSync(legacy)
      ? legacy
      : join(homedir(), '.claude.json')
    expect(resolveGlobalConfigFilePath()).toBe(expected)
  })

  test('honors CLAUDE_CONFIG_DIR as the directory holding the config file', () => {
    const configDir = makeTmpDir()
    process.env.CLAUDE_CONFIG_DIR = configDir

    expect(resolveGlobalConfigFilePath()).toBe(join(configDir, '.claude.json'))
    // Regression guard: the file must NOT be nested inside a `.claude`
    // subdirectory of the config dir.
    expect(resolveGlobalConfigFilePath()).not.toBe(
      join(configDir, '.claude', '.claude.json'),
    )
  })

  test('legacy <home>/.config.json wins when present', () => {
    const configDir = makeTmpDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    const legacy = join(configDir, LEGACY_GLOBAL_CONFIG_FILENAME)
    writeFileSync(legacy, '{}')

    expect(resolveGlobalConfigFilePath()).toBe(legacy)
  })

  test('legacy wins over an existing OAuth-suffixed file too', () => {
    const configDir = makeTmpDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'http://localhost:1234'
    const legacy = join(configDir, LEGACY_GLOBAL_CONFIG_FILENAME)
    writeFileSync(legacy, '{}')

    expect(resolveGlobalConfigFilePath()).toBe(legacy)
  })

  test('applies the OAuth filename suffix', () => {
    const configDir = makeTmpDir()
    process.env.CLAUDE_CONFIG_DIR = configDir

    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'http://localhost:1234'
    expect(resolveGlobalConfigFilePath()).toBe(
      join(configDir, '.claude-custom-oauth.json'),
    )

    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
    process.env.USER_TYPE = 'ant'
    process.env.USE_LOCAL_OAUTH = '1'
    expect(resolveGlobalConfigFilePath()).toBe(
      join(configDir, '.claude-local-oauth.json'),
    )

    delete process.env.USE_LOCAL_OAUTH
    process.env.USE_STAGING_OAUTH = '1'
    expect(resolveGlobalConfigFilePath()).toBe(
      join(configDir, '.claude-staging-oauth.json'),
    )

    // USE_STAGING_OAUTH only applies to the `ant` user type.
    delete process.env.USER_TYPE
    expect(resolveGlobalConfigFilePath()).toBe(join(configDir, '.claude.json'))
  })

  test('treats an explicit override as the config home', () => {
    const override = makeTmpDir()
    expect(resolveGlobalConfigFilePath(override)).toBe(
      join(override, '.claude.json'),
    )

    const legacy = join(override, LEGACY_GLOBAL_CONFIG_FILENAME)
    writeFileSync(legacy, '{}')
    expect(resolveGlobalConfigFilePath(override)).toBe(legacy)
  })

  test('an explicit override takes precedence over CLAUDE_CONFIG_DIR', () => {
    const envDir = makeTmpDir()
    const override = makeTmpDir()
    process.env.CLAUDE_CONFIG_DIR = envDir

    expect(resolveGlobalConfigFilePath(override)).toBe(
      join(override, '.claude.json'),
    )
  })
})

describe('globalConfigFileName', () => {
  test('matches the production name by default', () => {
    expect(globalConfigFileName()).toBe('.claude.json')
  })
})

describe('CLI and server resolve the same file', () => {
  const scenarios: Array<[string, () => void]> = [
    ['default', () => {}],
    [
      'CLAUDE_CONFIG_DIR',
      () => {
        process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'some-config-home')
      },
    ],
    [
      'CLAUDE_CONFIG_DIR + custom oauth',
      () => {
        process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'some-config-home')
        process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'http://localhost:1234'
      },
    ],
  ]

  for (const [name, setup] of scenarios) {
    test(name, () => {
      setup()
      getGlobalClaudeFile.cache.clear()
      // The CLI (getGlobalClaudeFile) and the shared server resolver must agree
      // on the exact same path.
      expect(resolveGlobalConfigFilePath()).toBe(getGlobalClaudeFile())
    })
  }

  test('with the legacy file present', () => {
    const configDir = makeTmpDir()
    process.env.CLAUDE_CONFIG_DIR = configDir
    writeFileSync(join(configDir, LEGACY_GLOBAL_CONFIG_FILENAME), '{}')
    getGlobalClaudeFile.cache.clear()

    expect(resolveGlobalConfigFilePath()).toBe(getGlobalClaudeFile())
  })
})
