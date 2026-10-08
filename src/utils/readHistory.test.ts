import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetReadHistoryForTest,
  isUnreadFileRefusal,
  partialViewRefusal,
  recordFileRead,
  resetReadHistory,
  unreadFileRefusal,
} from './readHistory.js'

const advice = {
  neverRead: 'Read it first before writing to it.',
  action: 'before editing it',
}

describe('unreadFileRefusal', () => {
  beforeEach(() => _resetReadHistoryForTest())

  test('nobody read it → never-read wording', () => {
    expect(unreadFileRefusal('/x/a.ts', undefined, advice)).toBe(
      'File has not been read yet. Read it first before writing to it.',
    )
  })

  test('the same agent read it → read-earlier wording', () => {
    recordFileRead('/x/a.ts', undefined)
    const message = unreadFileRefusal('/x/a.ts', undefined, advice)
    expect(message).toContain('You read this file earlier')
    expect(message).toContain('Read it again')
  })

  test('a different agent read it → other-agent wording', () => {
    recordFileRead('/x/a.ts', 'agent-1')
    const message = unreadFileRefusal('/x/a.ts', 'agent-2', advice)
    expect(message).toContain('read by another agent')
  })

  test('path normalization makes /x/./a.ts match /x/a.ts', () => {
    recordFileRead('/x/./a.ts', undefined)
    expect(unreadFileRefusal('/x/a.ts', undefined, advice)).toContain(
      'You read this file earlier',
    )
  })

  test('reset forgets everything', () => {
    recordFileRead('/x/a.ts', undefined)
    resetReadHistory()
    expect(unreadFileRefusal('/x/a.ts', undefined, advice)).toContain(
      'File has not been read yet',
    )
  })
})

describe('partialViewRefusal / isUnreadFileRefusal', () => {
  test('partial view wording names the action', () => {
    expect(partialViewRefusal('before editing it')).toContain(
      'Only part of this file has been read',
    )
  })

  test('recognizes every refusal prefix but not quoted body text', () => {
    expect(isUnreadFileRefusal('File has not been read yet. …')).toBe(true)
    expect(isUnreadFileRefusal('You read this file earlier, …')).toBe(true)
    expect(isUnreadFileRefusal('This file was read by another agent …')).toBe(true)
    expect(isUnreadFileRefusal(partialViewRefusal('before editing it'))).toBe(true)
    expect(isUnreadFileRefusal('the doc said: File has not been read yet')).toBe(
      false,
    )
  })
})
