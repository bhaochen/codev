import { describe, expect, it } from 'vitest'
import { deterministicUuid } from './deterministicUuid.js'

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('deterministicUuid', () => {
  it('is stable for the same key', () => {
    expect(deterministicUuid('task-notification:t1:completed')).toBe(
      deterministicUuid('task-notification:t1:completed'),
    )
  })

  it('differs across keys', () => {
    expect(deterministicUuid('task-notification:t1:completed')).not.toBe(
      deterministicUuid('task-notification:t1:failed'),
    )
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'))
  })

  it('produces valid v4-shaped UUIDs (version + variant bits)', () => {
    for (const key of ['', 'x', 'task-notification:abc:stall', '🔧']) {
      expect(deterministicUuid(key)).toMatch(UUID_V4_RE)
    }
  })

  it('does not collide for nearby keys within 32 hex chars', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const id = deterministicUuid(`task-notification:t${i}:completed`)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })
})
