import { describe, expect, test } from 'bun:test'
import {
  createRepetitionGuard,
  detectDegenerateRepetition,
  formatRepetitionNotice,
  trimRepeatedTail,
} from './degenerateRepetition.js'

const OPTS = { minRepeats: 5, minRepeatedChars: 30 }

describe('detectDegenerateRepetition', () => {
  test('plain prose is never flagged', () => {
    expect(detectDegenerateRepetition('a normal answer that does not loop at all', OPTS)).toBeNull()
  })

  test('an exactly repeating tail is detected with the smallest period', () => {
    const text = 'abc'.repeat(30) // 90 chars, period 3
    const det = detectDegenerateRepetition(text, OPTS)
    expect(det).not.toBeNull()
    expect(det!.period).toBe(3)
    expect(det!.repeats).toBe(30)
    expect(det!.keepChars).toBe(3)
  })

  test('detection is phase-independent (tail ends mid-unit)', () => {
    const text = `${'abc'.repeat(40)}ab` // ends two chars into the unit
    const det = detectDegenerateRepetition(text, OPTS)
    expect(det).not.toBeNull()
    expect(det!.period).toBe(3)
  })

  test('a too-short run is not flagged', () => {
    // Only 3 repeats of a 3-char unit, below minRepeats 5.
    expect(detectDegenerateRepetition('abcabcabc', OPTS)).toBeNull()
  })

  test('a threshold of one repeat is rejected as meaningless', () => {
    expect(
      detectDegenerateRepetition('abc'.repeat(30), {
        minRepeats: 1,
        minRepeatedChars: 1,
      }),
    ).toBeNull()
  })
})

describe('trimRepeatedTail / formatRepetitionNotice', () => {
  test('keeps the prefix plus one unit, then appends the notice', () => {
    const text = `intro ${'abc'.repeat(30)}`
    const det = detectDegenerateRepetition(text, OPTS)!
    const trimmed = trimRepeatedTail(text, det)
    expect(trimmed.length).toBeLessThan(text.length)
    expect(trimmed).toBe(`intro abc`)
    expect(formatRepetitionNotice(det)).toContain('began repeating')
  })
})

describe('createRepetitionGuard', () => {
  test('throttles: growth under the check interval is skipped', () => {
    const guard = createRepetitionGuard(OPTS)
    // 900 chars so the first check clears CHECK_INTERVAL_CHARS (256).
    const text = 'abc'.repeat(300)
    expect(guard.check(0, text)).not.toBeNull()
    // Same length (no growth) → skipped.
    expect(guard.check(0, text)).toBeNull()
  })

  test('blocks are tracked independently', () => {
    const guard = createRepetitionGuard(OPTS)
    const text = 'abc'.repeat(300)
    expect(guard.check(0, text)).not.toBeNull()
    expect(guard.check(1, text)).not.toBeNull()
  })
})
