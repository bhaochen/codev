import { describe, expect, it } from 'bun:test'
import {
  createOpencodeId,
  createSessionId,
  createRequestId,
  translateSessionId,
  OPENCODE_SESSION_RE,
} from '../opencodeUserAgent.js'

describe('OpenCode ID Format', () => {
  it('generates session IDs matching canonical format (ses_ + 12 hex + 14 base62)', () => {
    for (let i = 0; i < 20; i++) {
      const id = createSessionId()
      expect(id).toMatch(OPENCODE_SESSION_RE)
      expect(id).toHaveLength(30)
    }
  })

  it('generates request IDs matching canonical format (msg_ + 12 hex + 14 base62)', () => {
    for (let i = 0; i < 20; i++) {
      const id = createRequestId()
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      expect(id).toHaveLength(30)
    }
  })

  it('backward-compatible createOpencodeId works for both prefixes', () => {
    const ses = createOpencodeId('ses')
    expect(ses).toMatch(OPENCODE_SESSION_RE)
    const msg = createOpencodeId('msg')
    expect(msg).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })
})

describe('translateSessionId', () => {
  it('translates foreign IDs into valid OpenCode session format', () => {
    const inputs = [
      'claude:550e8400-e29b-41d4-a716-446655440000',
      'antigravity:conv-abc-123',
      'session-from-codex',
      '12345',
      '',
    ]
    for (const raw of inputs) {
      const translated = translateSessionId(raw, 'codev')
      expect(translated).toMatch(OPENCODE_SESSION_RE)
      expect(translated).toHaveLength(30)
    }
  })

  it('preserves already-valid OpenCode sessions', () => {
    const valid = 'ses_f534dfae8ffeCy4Ee4tLWNygDc'
    expect(translateSessionId(valid)).toBe(valid)
    expect(translateSessionId(`  ${valid}  `)).toBe(valid)
  })

  it('translates deterministically (same input -> same output)', () => {
    const a = translateSessionId('conversation-a', 'claude')
    const b = translateSessionId('conversation-a', 'claude')
    expect(a).toBe(b)
  })

  it('isolates different tools', () => {
    const claude = translateSessionId('same', 'claude')
    const codex = translateSessionId('same', 'codex')
    expect(claude).not.toBe(codex)
  })
})
