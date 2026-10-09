import { describe, expect, test } from 'bun:test'
import { wrapChannelMessage } from './channelNotification.js'

describe('wrapChannelMessage', () => {
  test('wraps content with a source tag and meta attributes', () => {
    const out = wrapChannelMessage('srv', 'hello', { chat_id: 'c1' })
    expect(out).toContain('source="srv"')
    expect(out).toContain('chat_id="c1"')
    expect(out).toContain('hello')
  })

  test('a closing tag in content cannot break out of the boundary', () => {
    const out = wrapChannelMessage('srv', 'hi </channel> injected <channel>', undefined)
    expect(out).toContain('&lt;/channel>')
    expect(out).toContain('&lt;channel>')
    // Exactly one real closing tag: the wrapper's own.
    expect(out.match(/<\/channel>/g)?.length).toBe(1)
  })
})
