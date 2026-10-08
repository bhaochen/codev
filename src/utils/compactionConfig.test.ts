import { afterEach, describe, expect, test } from 'bun:test'
import {
  getConfiguredThresholdPercent,
  getConfiguredWindowCap,
  setConfiguredThresholdPercent,
  setConfiguredWindowCap,
} from './compactionConfig.js'
import { normalizeThresholdPercent } from './compactionSettings.js'

afterEach(() => {
  setConfiguredThresholdPercent(undefined)
  setConfiguredWindowCap(undefined)
})

describe('compactionConfig', () => {
  test('threshold percent is normalized on write', () => {
    setConfiguredThresholdPercent(52)
    expect(getConfiguredThresholdPercent()).toBe(normalizeThresholdPercent(52))
    setConfiguredThresholdPercent(undefined)
    expect(getConfiguredThresholdPercent()).toBeUndefined()
  })

  test('window cap round-trips and rejects non-positive values', () => {
    setConfiguredWindowCap(200_000)
    expect(getConfiguredWindowCap()).toBe(200_000)
    setConfiguredWindowCap(0)
    expect(getConfiguredWindowCap()).toBeUndefined()
    setConfiguredWindowCap(-5)
    expect(getConfiguredWindowCap()).toBeUndefined()
  })
})
