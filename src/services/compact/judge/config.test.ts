import { describe, expect, test } from 'bun:test'
import { loadConfig, parseConfig } from './config.js'

/**
 * The judge is configured under `judge` in `~/.claude/settings.json`, with `CODEV_JUDGE_*` over it. These tests
 * cover the shape of that configuration, not the settings.json reader itself: `loadConfig({ settings })` is what
 * the rest of the kernel sees, and what these pin down is that a malformed or hostile key falls back rather than
 * throwing — compaction must never fail because a settings file says something odd.
 */

describe('parseConfig', () => {
  test('reads tiers, judges, modes, routes and features', () => {
    const config = parseConfig({
      tiers: ['jev', 'local'],
      judges: { luna: { type: 'local', baseUrl: 'http://127.0.0.1:47824' } },
      modes: { default: 'shadow', 'context.compact': 'active' },
      routes: { 'browser.step': ['luna'] },
      features: { compaction: { keepThreshold: 0.7 } },
      recordState: true,
    })

    expect(config.tiers).toEqual(['jev', 'local'])
    expect(config.judges.luna).toEqual({ type: 'local', baseUrl: 'http://127.0.0.1:47824' })
    expect(config.modes).toEqual({ default: 'shadow', 'context.compact': 'active' })
    expect(config.routes['browser.step']).toEqual(['luna'])
    expect(config.features.compaction).toEqual({ keepThreshold: 0.7 })
    expect(config.recordState).toBe(true)
  })

  test('drops what it cannot read instead of throwing', () => {
    const config = parseConfig({
      tiers: 'not-an-array',
      judges: { broken: { type: 'nonsense' }, missingType: {}, fine: { type: 'mock' } },
      modes: { 'context.compact': 'loud', 'browser.step': 'off' },
      features: 'not-an-object',
      recordState: 'yes',
    })

    expect(config.tiers).toEqual(['jev'])
    expect(Object.keys(config.judges)).toEqual(['fine'])
    expect(config.modes).toEqual({ default: 'shadow', 'browser.step': 'off' })
    expect(config.features).toEqual({})
    expect(config.recordState).toBe(false)
  })

  test('a missing or malformed key is the default configuration', () => {
    expect(parseConfig(undefined).tiers).toEqual(['jev'])
    expect(parseConfig('judge').modes.default).toBe('shadow')
  })
})

describe('loadConfig', () => {
  test('CODEV_JUDGE replaces the tiers from settings.json', () => {
    const { config, disabled } = loadConfig({
      settings: { tiers: ['mock'], modes: { default: 'shadow' } },
      env: { CODEV_JUDGE: ' local , jev ' },
    })

    expect(disabled).toBe(false)
    expect(config.tiers).toEqual(['local', 'jev'])
  })

  test('CODEV_JUDGE=off disables the kernel, so compaction falls back to the summary', () => {
    expect(loadConfig({ settings: { tiers: ['jev'] }, env: { CODEV_JUDGE: 'off' } }).disabled).toBe(true)
  })

  test('CODEV_JUDGE_MODE sets the default mode and leaves per-decision overrides alone', () => {
    const { config } = loadConfig({
      settings: { modes: { default: 'off', 'browser.step': 'shadow' } },
      env: { CODEV_JUDGE_MODE: 'active' },
    })

    expect(config.modes).toEqual({ default: 'active', 'browser.step': 'shadow' })
  })

  test('an unusable CODEV_JUDGE_MODE is ignored rather than applied', () => {
    const { config } = loadConfig({ settings: {}, env: { CODEV_JUDGE_MODE: 'loud' } })

    expect(config.modes.default).toBe('shadow')
  })

  test('only CODEV_JUDGE_* is read: names belonging to another tool are not ours to honor', () => {
    const { config } = loadConfig({ settings: { tiers: ['mock'] }, env: { MU_JUDGE: 'jev', KYRN_TIERS: 'clm' } })

    expect(config.tiers).toEqual(['mock'])
  })
})
