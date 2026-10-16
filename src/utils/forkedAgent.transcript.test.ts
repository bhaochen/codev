/**
 * Fix B — compaction forks must not persist a sidechain transcript.
 *
 * The compaction summariser is a forked agent whose context is the parent's
 * whole history (forked for prompt-cache reuse). Its transcript used to be
 * written to disk, storing that history again on every attempt — including the
 * failed (rate-limited) retries. `skipTranscript: true` suppresses all
 * transcript I/O; compact.ts passes it for the `compact` fork label.
 *
 * These tests exercise `runForkedAgent` directly with a stubbed query loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

vi.mock('./sessionStorage.js', () => ({
  recordSidechainTranscript: vi.fn(async () => {}),
}))
vi.mock('../query.js', () => ({ query: vi.fn() }))

import { runForkedAgent } from './forkedAgent.js'
import { recordSidechainTranscript } from './sessionStorage.js'
import { query } from '../query.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import type { Message } from '../types/message.js'

const recordMock = recordSidechainTranscript as unknown as ReturnType<typeof vi.fn>
const queryMock = query as unknown as ReturnType<typeof vi.fn>

function user(uuid: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: 'x' },
  } as unknown as Message
}
function assistant(uuid: string): Message {
  return { type: 'assistant', uuid } as unknown as Message
}

function makeParams(extra: Record<string, unknown> = {}) {
  return {
    promptMessages: [user('u1')],
    cacheSafeParams: {
      systemPrompt: [],
      userContext: {},
      systemContext: {},
      toolUseContext: {
        abortController: new AbortController(),
        getAppState: () => ({ toolPermissionContext: {} }),
        readFileState: createFileStateCacheWithSizeLimit(100),
        options: {},
        messages: [],
      },
      forkContextMessages: [user('c1'), assistant('c2')],
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    querySource: 'compact',
    forkLabel: 'compact',
    ...extra,
  } as never
}

let capturedLengths: number[] = []

beforeEach(() => {
  capturedLengths = []
  recordMock.mockReset()
  recordMock.mockImplementation(async (entries: unknown[]) => {
    capturedLengths.push(entries.length)
  })
  queryMock.mockReset()
  queryMock.mockImplementation(async function* () {
    yield assistant('a1')
  })
})

describe('runForkedAgent transcript recording', () => {
  it('records a sidechain transcript when skipTranscript is not set', async () => {
    await runForkedAgent(makeParams())
    // Initial fork context [c1, c2, u1], then the agent's own assistant turn.
    expect(capturedLengths[0]).toBe(3)
    expect(capturedLengths.length).toBeGreaterThanOrEqual(2)
  })

  it('skipTranscript avoids every transcript write (compaction fork)', async () => {
    await runForkedAgent(makeParams({ skipTranscript: true }))
    expect(capturedLengths).toEqual([])
  })
})

describe('compaction call site (linkage guard)', () => {
  it('compaction passes skipTranscript: true to runForkedAgent', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(
      join(here, '..', 'services', 'compact', 'compact.ts'),
      'utf8',
    )
    const at = src.indexOf('await runForkedAgent({')
    expect(at).toBeGreaterThan(-1)
    // The option must be inside that call's argument object.
    const args = src.slice(at, src.indexOf('\n        })', at))
    expect(args).toMatch(/skipTranscript:\s*true/)
  })
})
