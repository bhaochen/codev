/**
 * Resume parity: what a resumed subagent needs to repeat its spawn's prefix.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Tool, Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  _resetAgentConversationsForTest,
  getAgentConversation,
  refuseToolsOutsideRunPolicy,
  rememberAgentConversation,
} from './resumeParity.js'

const msg = (uuid: string, type = 'user'): Message =>
  ({ type, uuid }) as unknown as Message

function tool(name: string, extra: Record<string, unknown> = {}): Tool {
  return {
    name,
    inputSchema: { shape: { a: 1 } },
    async prompt() {
      return `prompt of ${name}`
    },
    async validateInput() {
      return { result: true }
    },
    ...extra,
  } as unknown as Tool
}

beforeEach(() => {
  _resetAgentConversationsForTest()
})

describe('live agent conversations', () => {
  test('returns the remembered conversation in order', () => {
    rememberAgentConversation('a1', [
      msg('u1'),
      msg('a1', 'assistant'),
      msg('att', 'attachment'),
    ])
    const got = getAgentConversation('a1')
    expect(got?.map(m => m.uuid).join(',')).toBe('u1,a1,att')
  })

  test('unknown agent falls back (undefined)', () => {
    expect(getAgentConversation('nope')).toBeUndefined()
  })

  test('stores and hands out copies, never the live arrays', () => {
    const live = [msg('u1')]
    rememberAgentConversation('a1', live)
    live.push(msg('late'))
    const first = getAgentConversation('a1')!
    first.push(msg('mutated'))
    const second = getAgentConversation('a1')!
    expect(second.length).toBe(1)
  })

  test('a newer run of the same agent replaces its conversation', () => {
    rememberAgentConversation('a1', [msg('old')])
    rememberAgentConversation('a1', [msg('old'), msg('new')])
    expect(getAgentConversation('a1')?.length).toBe(2)
  })

  test('caps held conversations, dropping the least recently finished', () => {
    for (let i = 0; i < 16; i++) {
      rememberAgentConversation(`a${i}`, [msg(`u${i}`)])
    }
    rememberAgentConversation('a0', [msg('u0-again')]) // a0 finishes again: now newest
    rememberAgentConversation('a16', [msg('u16')])
    expect(getAgentConversation('a1')).toBeUndefined()
    expect(getAgentConversation('a0')).toBeDefined()
    expect(getAgentConversation('a16')).toBeDefined()
  })
})

describe('refuseToolsOutsideRunPolicy', () => {
  test('all tools runnable: the declared array is returned untouched', () => {
    const declared: Tools = [tool('Read'), tool('Grep')]
    const out = refuseToolsOutsideRunPolicy(declared, declared, 'x')
    expect(out).toBe(declared)
  })

  test('tools outside the run policy stay declared but refuse to run', async () => {
    const read = tool('Read')
    const send = tool('SendMessage', { description: 'send it' })
    const out = refuseToolsOutsideRunPolicy(
      [read, send],
      [read],
      'is not available in the background.',
    )
    expect(out.length).toBe(2)
    expect(out[0]).toBe(read)
    const wrapped = out[1]!
    expect(wrapped).not.toBe(send)
    expect(wrapped.name).toBe('SendMessage')
    expect((wrapped as unknown as { description?: string }).description).toBe('send it')
    expect(wrapped.inputSchema).toBe(send.inputSchema)
    expect(await wrapped.prompt(undefined as never)).toBe('prompt of SendMessage')
    const verdict = await wrapped.validateInput!({} as never, {} as never)
    expect(verdict.result).toBe(false)
    if (verdict.result === false) {
      expect(verdict.message).toBe(
        'SendMessage is not available in the background.',
      )
    }
    const original = await send.validateInput!({} as never, {} as never)
    expect(original.result).toBe(true)
  })

  test('declaration order is preserved (tool order is part of the prefix)', () => {
    const names = ['Agent', 'Read', 'SendMessage', 'Grep', 'TaskCreate']
    const declared = names.map(n => tool(n))
    const runnable = declared.filter(t => t.name === 'Read' || t.name === 'Grep')
    const out = refuseToolsOutsideRunPolicy(declared, runnable, 'x')
    expect(out.map(t => t.name)).toEqual(names)
  })

  test('getter-defined fields keep their values in the refused copy', () => {
    const schema = { shape: { to: 1 } }
    const withGetter = {
      name: 'SendMessage',
      get inputSchema() {
        return schema
      },
    } as unknown as Tool
    const [out] = refuseToolsOutsideRunPolicy([withGetter], [], 'x')
    expect(out!.inputSchema as unknown).toBe(schema)
  })

  test('with `when`, a tool refuses only once the agent runs in the background', async () => {
    let backgrounded = false
    const seen: unknown[] = []
    const own = tool('TaskCreate', {
      async validateInput(input: unknown) {
        seen.push(input)
        return { result: false, message: 'own rule', errorCode: 7 }
      },
    })
    const plain = tool('AskUserQuestion', { validateInput: undefined })
    const [ownOut, plainOut] = refuseToolsOutsideRunPolicy(
      [own, plain],
      [],
      'is not available in the background.',
      () => backgrounded,
    )
    // Foreground: each tool keeps its own validation (or none).
    const ownVerdict = await ownOut!.validateInput!({ subject: 'a' } as never, {} as never)
    expect(ownVerdict.result).toBe(false)
    if (ownVerdict.result === false) expect(ownVerdict.message).toBe('own rule')
    expect(seen).toEqual([{ subject: 'a' }])
    const plainVerdict = await plainOut!.validateInput!({} as never, {} as never)
    expect(plainVerdict.result).toBe(true)
    // Moved to the background: both refuse, without calling the tool's own rule.
    backgrounded = true
    for (const out of [ownOut!, plainOut!]) {
      const verdict = await out.validateInput!({} as never, {} as never)
      expect(verdict.result).toBe(false)
      if (verdict.result === false) {
        expect(verdict.message).toBe(
          `${out.name} is not available in the background.`,
        )
      }
    }
    expect(seen.length).toBe(1)
  })
})
