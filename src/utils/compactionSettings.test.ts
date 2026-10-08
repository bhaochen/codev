import { describe, expect, test } from 'bun:test'
import {
  COMPACT_THRESHOLD_MAX_PERCENT,
  COMPACT_THRESHOLD_MIN_PERCENT,
  COMPACT_THRESHOLD_STEP_PERCENT,
  computeCompactionThreshold,
  formatTokenCount,
  isValidThresholdPercent,
  isValidWindowCap,
  normalizeThresholdPercent,
} from './compactionSettings.js'

describe('normalizeThresholdPercent', () => {
  test('clamps to range and rounds to the step', () => {
    expect(normalizeThresholdPercent(0)).toBe(COMPACT_THRESHOLD_MIN_PERCENT)
    expect(normalizeThresholdPercent(1000)).toBe(COMPACT_THRESHOLD_MAX_PERCENT)
    expect(normalizeThresholdPercent(52)).toBe(50)
    expect(normalizeThresholdPercent(53)).toBe(55)
    expect(normalizeThresholdPercent(Number.NaN)).toBe(
      COMPACT_THRESHOLD_MAX_PERCENT,
    )
  })

  test('step is the documented granularity', () => {
    expect(COMPACT_THRESHOLD_STEP_PERCENT).toBe(5)
  })
})

describe('validators', () => {
  test('isValidThresholdPercent rejects out-of-range', () => {
    expect(isValidThresholdPercent(20)).toBe(true)
    expect(isValidThresholdPercent(90)).toBe(true)
    expect(isValidThresholdPercent(19)).toBe(false)
    expect(isValidThresholdPercent(91)).toBe(false)
    expect(isValidThresholdPercent('50')).toBe(false)
  })

  test('isValidWindowCap requires a positive finite number', () => {
    expect(isValidWindowCap(200_000)).toBe(true)
    expect(isValidWindowCap(0)).toBe(false)
    expect(isValidWindowCap(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('computeCompactionThreshold', () => {
  const base = { contextWindow: 200_000, reservedForSummary: 33_000, bufferTokens: 1_000 }

  test('auto = window minus the reserve', () => {
    const r = computeCompactionThreshold({
      ...base,
      thresholdPercent: undefined,
      windowCap: undefined,
    })
    expect(r.threshold).toBe(200_000 - 34_000)
    expect(r.usedProportionalReserve).toBe(false)
    expect(r.clampedByReserve).toBe(false)
  })

  test('a percentage lowers the threshold below auto', () => {
    const r = computeCompactionThreshold({
      ...base,
      thresholdPercent: 50,
      windowCap: undefined,
    })
    expect(r.threshold).toBe(Math.floor((200_000 - 33_000) * 0.5))
    expect(r.threshold).toBeLessThan(200_000 - 34_000)
  })

  test('a percentage above the reserve is clamped by auto', () => {
    // A large buffer makes auto smaller than 90% of the usable window.
    const r = computeCompactionThreshold({
      ...base,
      bufferTokens: 50_000,
      thresholdPercent: 90,
      windowCap: undefined,
    })
    expect(r.clampedByReserve).toBe(true)
    expect(r.threshold).toBe(200_000 - 83_000)
  })

  test('a window cap intersects the model window', () => {
    const r = computeCompactionThreshold({
      ...base,
      thresholdPercent: undefined,
      windowCap: 100_000,
    })
    expect(r.threshold).toBe(100_000 - 34_000)
  })

  test('a tiny window switches to the proportional reserve', () => {
    const r = computeCompactionThreshold({
      contextWindow: 8_000,
      reservedForSummary: 33_000,
      bufferTokens: 1_000,
      thresholdPercent: undefined,
      windowCap: undefined,
    })
    expect(r.usedProportionalReserve).toBe(true)
    expect(r.threshold).toBeGreaterThan(0)
  })
})

describe('formatTokenCount', () => {
  test('renders K and M', () => {
    expect(formatTokenCount(200_000)).toBe('200K')
    expect(formatTokenCount(1_048_576)).toBe('1M')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
    expect(formatTokenCount(999)).toBe('999')
  })
})
