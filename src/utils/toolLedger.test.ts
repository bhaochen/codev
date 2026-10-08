import { describe, expect, test } from 'bun:test'
import {
  buildLoopBreakerGuidance,
  collectToolCalls,
  detectToolLoop,
  toolInputKey,
  type LedgerToolCall,
} from './toolLedger.js'

type Block = {
  type: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
  text?: string
}
type Msg = { type: string; message?: { role?: string; content?: readonly Block[] } }

function call(id: string, name: string, input: unknown): Msg {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  }
}
function result(id: string, text: string, isError: boolean): Msg {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }],
    },
  }
}

describe('toolInputKey', () => {
  test('is order-independent for object keys', () => {
    expect(toolInputKey({ a: 1, b: 2 })).toBe(toolInputKey({ b: 2, a: 1 }))
  })

  test('distinguishes different inputs and long payloads', () => {
    expect(toolInputKey({ a: 1 })).not.toBe(toolInputKey({ a: 2 }))
    const long1 = { body: 'x'.repeat(10_000) }
    const long2 = { body: 'x'.repeat(10_000) + 'y' }
    expect(toolInputKey(long1)).not.toBe(toolInputKey(long2))
  })
})

describe('collectToolCalls', () => {
  test('pairs each call with its result', () => {
    const calls = collectToolCalls([
      call('1', 'Bash', { command: 'ls' }),
      result('1', 'ok', false),
      call('2', 'Bash', { command: 'bad' }),
      result('2', 'boom', true),
      call('3', 'Read', { file: 'x' }),
    ])
    expect(calls.map(c => c.ok)).toEqual([true, false, undefined])
    expect(calls[1]!.errorText).toBe('boom')
  })

  test('ignores an orphan result and dedups a repeated id', () => {
    const calls = collectToolCalls([
      result('missing', 'x', true),
      call('1', 'Bash', { command: 'ls' }),
      call('1', 'Bash', { command: 'ls' }),
    ])
    expect(calls).toHaveLength(1)
  })
})

function ledger(
  entries: Array<{ name: string; input: unknown; ok: boolean | undefined }>,
): LedgerToolCall[] {
  return entries.map((e, i) => ({
    id: String(i),
    name: e.name,
    inputKey: toolInputKey(e.input),
    inputPreview: JSON.stringify(e.input),
    ok: e.ok,
    errorText: e.ok === false ? 'boom' : undefined,
  }))
}

describe('detectToolLoop', () => {
  test('flags a run of identical consecutive failures', () => {
    const det = detectToolLoop(
      ledger([
        { name: 'Bash', input: { c: 'x' }, ok: false },
        { name: 'Bash', input: { c: 'x' }, ok: false },
        { name: 'Bash', input: { c: 'x' }, ok: false },
      ]),
    )
    expect(det).not.toBeNull()
    expect(det!.name).toBe('Bash')
    expect(det!.count).toBe(3)
  })

  test('a success or different args breaks the run', () => {
    expect(
      detectToolLoop(
        ledger([
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: true },
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: false },
        ]),
      ),
    ).not.toBeNull() // tail run of 3 still counts
    expect(
      detectToolLoop(
        ledger([
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'y' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: false },
        ]),
      ),
    ).toBeNull()
  })

  test('below threshold, in-flight tail, and a success tail are not loops', () => {
    expect(
      detectToolLoop(
        ledger([
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: false },
        ]),
      ),
    ).toBeNull()
    expect(
      detectToolLoop(
        ledger([
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: undefined },
        ]),
      ),
    ).not.toBeNull()
    expect(
      detectToolLoop(
        ledger([
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: false },
          { name: 'Bash', input: { c: 'x' }, ok: true },
        ]),
      ),
    ).toBeNull()
  })
})

describe('buildLoopBreakerGuidance', () => {
  test('names the tool, the count, and the failure', () => {
    const guidance = buildLoopBreakerGuidance({
      name: 'Bash',
      inputKey: 'k',
      inputPreview: '{"command":"ls"}',
      count: 4,
      errorText: 'permission denied',
    })
    expect(guidance).toContain('Bash 4 times')
    expect(guidance).toContain('permission denied')
    expect(guidance).toContain('Do not issue this call again unchanged.')
  })
})
