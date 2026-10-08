import { describe, expect, test } from 'bun:test'
import {
  InFlightToolCall,
  isOutputCapTruncation,
  laneStopReason,
} from './outputCapTruncation.js'

describe('isOutputCapTruncation', () => {
  test('recognizes every spelling, case/space-insensitively', () => {
    expect(isOutputCapTruncation('length')).toBe(true)
    expect(isOutputCapTruncation('max_tokens')).toBe(true)
    expect(isOutputCapTruncation('MAX_OUTPUT_TOKENS')).toBe(true)
    expect(isOutputCapTruncation('  Length ')).toBe(true)
  })

  test('rejects normal finish reasons', () => {
    expect(isOutputCapTruncation('stop')).toBe(false)
    expect(isOutputCapTruncation('tool_calls')).toBe(false)
    expect(isOutputCapTruncation(undefined)).toBe(false)
    expect(isOutputCapTruncation(42)).toBe(false)
  })
})

describe('laneStopReason', () => {
  test('truncation outranks tool use', () => {
    expect(laneStopReason({ truncated: true, hadToolUse: true })).toBe(
      'max_tokens',
    )
    expect(laneStopReason({ truncated: false, hadToolUse: true })).toBe(
      'tool_use',
    )
    expect(laneStopReason({ truncated: false, hadToolUse: false })).toBe(
      'end_turn',
    )
  })
})

describe('InFlightToolCall', () => {
  test('reports the most recent argument-bearing call', () => {
    const inFlight = new InFlightToolCall<number>()
    inFlight.noteArgs(0)
    inFlight.noteArgs(1)
    expect(inFlight.toDrop(true)).toBe(1)
    expect(inFlight.toDrop(false)).toBeNull()
  })

  test('other output closes the in-flight call', () => {
    const inFlight = new InFlightToolCall<number>()
    inFlight.noteArgs(0)
    inFlight.noteOtherOutput()
    expect(inFlight.toDrop(true)).toBeNull()
  })

  test('noteSettled only clears the matching key', () => {
    const inFlight = new InFlightToolCall<number>()
    inFlight.noteArgs(2)
    inFlight.noteSettled(1)
    expect(inFlight.toDrop(true)).toBe(2)
    inFlight.noteSettled(2)
    expect(inFlight.toDrop(true)).toBeNull()
  })
})
