process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key-for-wire-tests"
import { describe, test, expect } from 'bun:test'
import {
  anthropicBlockToAgent,
  agentBlockToAnthropic,
} from './anthropicAdapter.js'
import {
  createAssistantMessage,
  createTextBlock,
  createThinkingBlock,
  createToolUseBlock,
  createUserMessage,
  type AgentContentBlock,
} from './agentMessage.js'
import { normalizeContentFromAPI } from '../utils/messages.js'
import {
  createUserMessage as createStoreUserMessage,
} from '../utils/messages.js'
import {
  addCacheBreakpoints,
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from '../services/llm/clients/anthropicMessages.js'
import type {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'

// ============================================================================
// Path test: Agent Core → AgentMessage → Anthropic Adapter → Anthropic API
//
// Asserts the full store↔wire pipeline introduced by the AgentMessage
// canonicalization migration:
//   1. store boundary: normalizeContentFromAPI (raw Anthropic-shaped API
//      output → canonical AgentContentBlock[])
//   2. wire boundary: userMessageToMessageParam / assistantMessageToMessageParam
//      (stored Agent content → Anthropic MessageParam wire blocks, request-time
//      cache_control applied, no providerOptions leak)
//   3. addCacheBreakpoints: exactly-one-marker placement constraint
//   4. store→wire roundtrip losslessness for normalized content
// ============================================================================

const UUID = 'path-test-uuid'
const TS = 1700000000000

function userMsg(content: AgentContentBlock[]) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content, uuid: UUID, timestamp: TS },
  }
}

function assistantMsg(content: AgentContentBlock[]) {
  return {
    type: 'assistant' as const,
    message: {
      role: 'assistant' as const,
      content,
      uuid: UUID,
      timestamp: TS,
    },
  }
}

function wireContent(param: MessageParam): ContentBlockParam[] {
  return Array.isArray(param.content) ? param.content : [param.content]
}

function expectNoProviderOptions(blocks: ContentBlockParam[]): void {
  for (const block of blocks) {
    expect(Object.keys(block)).not.toContain('providerOptions')
  }
}

// ============================================================================
// 1. Store boundary: normalizeContentFromAPI → canonical Agent content
// ============================================================================

describe('store boundary: normalizeContentFromAPI', () => {
  test('plain text block → canonical AgentTextBlock', () => {
    const raw = [{ type: 'text', text: 'Hello' }] as unknown as AgentContentBlock[]
    const stored = normalizeContentFromAPI(raw, [])
    expect(stored).toEqual([{ type: 'text', text: 'Hello' }])
  })

  test('text block with citations → providerOptions.citations preserved', () => {
    const citations = [
      {
        cited_text: 'quoted line',
        document_index: 0,
        document_title: 'doc.txt',
        start_char_index: 0,
        end_char_index: 11,
      },
    ]
    const raw = [
      { type: 'text', text: 'quoted line', citations },
    ] as unknown as AgentContentBlock[]
    const stored = normalizeContentFromAPI(raw, [])
    expect(stored).toEqual([
      { type: 'text', text: 'quoted line', providerOptions: { citations } },
    ])
  })

  test('tool_use with object input → AgentToolUseBlock', () => {
    const raw = [
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
    ] as unknown as AgentContentBlock[]
    const stored = normalizeContentFromAPI(raw, [])
    expect(stored).toEqual([
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
    ])
  })

  test('tool_use with stringified input → parsed object input', () => {
    const raw = [
      {
        type: 'tool_use',
        id: 't2',
        name: 'bash',
        input: '{"command":"pwd"}',
      },
    ] as unknown as AgentContentBlock[]
    const stored = normalizeContentFromAPI(raw, [])
    expect(stored).toEqual([
      { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'pwd' } },
    ])
  })

  test('thinking block → AgentThinkingBlock', () => {
    const raw = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig_1' },
    ] as unknown as AgentContentBlock[]
    const stored = normalizeContentFromAPI(raw, [])
    expect(stored).toEqual([
      { type: 'thinking', thinking: 'hmm', signature: 'sig_1' },
    ])
  })

  test('escape-hatch block (server_tool_use) passes through verbatim', () => {
    const raw = [
      { type: 'server_tool_use', id: 's1', name: 'mcp', input: '{"a":1}' },
    ] as unknown as AgentContentBlock[]
    const stored = normalizeContentFromAPI(raw, [])
    expect(stored).toEqual([
      { type: 'server_tool_use', id: 's1', name: 'mcp', input: { a: 1 } },
    ])
  })
})

// ============================================================================
// 2. Wire boundary: stored Agent content → Anthropic MessageParam
// ============================================================================

describe('wire boundary: userMessageToMessageParam', () => {
  test('stored Agent content → wire blocks, no providerOptions leak', () => {
    const msg = userMsg([
      createTextBlock('Hello'),
      createToolUseBlock('t1', 'bash', { command: 'ls' }),
    ])
    const param = userMessageToMessageParam(
      msg as unknown as Parameters<typeof userMessageToMessageParam>[0],
      false,
      true,
    )
    const content = wireContent(param)
    expect(content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
    ])
    expectNoProviderOptions(content)
  })

  test('addCache + enablePromptCaching → cache_control on last block only', () => {
    const msg = userMsg([
      createTextBlock('Hello'),
      createToolUseBlock('t1', 'bash', { command: 'ls' }),
    ])
    const param = userMessageToMessageParam(
      msg as unknown as Parameters<typeof userMessageToMessageParam>[0],
      true,
      true,
    )
    const content = wireContent(param)
    expect(content[0]).toEqual({ type: 'text', text: 'Hello' })
    expect(content[0]).not.toHaveProperty('cache_control')
    expect(content[1]).toEqual({
      type: 'tool_use',
      id: 't1',
      name: 'bash',
      input: { command: 'ls' },
      cache_control: { type: 'ephemeral' },
    })
  })

  test('addCache + disablePromptCaching → no cache_control', () => {
    const msg = userMsg([createTextBlock('Hello')])
    const param = userMessageToMessageParam(
      msg as unknown as Parameters<typeof userMessageToMessageParam>[0],
      true,
      false,
    )
    expect(param.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  test('stored providerOptions.cache_control → wire cache_control restored', () => {
    const block = {
      ...createTextBlock('Hello'),
      providerOptions: { cache_control: { type: 'ephemeral' } },
    }
    const msg = userMsg([block])
    const param = userMessageToMessageParam(
      msg as unknown as Parameters<typeof userMessageToMessageParam>[0],
      true,
      true,
    )
    // The request-time marker overwrites the restored one on the last block.
    expect(param.content).toEqual([
      {
        type: 'text',
        text: 'Hello',
        cache_control: { type: 'ephemeral' },
      },
    ])
  })

  test('string content → wrapped text block with marker in addCache mode', () => {
    const msg = {
      type: 'user' as const,
      message: { role: 'user' as const, content: 'Hello', uuid: UUID, timestamp: TS },
    }
    const param = userMessageToMessageParam(
      msg as unknown as Parameters<typeof userMessageToMessageParam>[0],
      true,
      true,
    )
    expect(param).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
      ],
    })
  })
})

describe('wire boundary: assistantMessageToMessageParam', () => {
  test('stored Agent content → wire blocks, no providerOptions leak', () => {
    const msg = assistantMsg([
      createTextBlock('Answer'),
      createToolUseBlock('t1', 'bash', { command: 'ls' }),
    ])
    const param = assistantMessageToMessageParam(
      msg as unknown as Parameters<typeof assistantMessageToMessageParam>[0],
      false,
      true,
    )
    const content = wireContent(param)
    expect(content).toEqual([
      { type: 'text', text: 'Answer' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
    ])
    expectNoProviderOptions(content)
  })

  test('marker lands on last block when it is not a thinking block', () => {
    const msg = assistantMsg([
      createTextBlock('Answer'),
      createToolUseBlock('t1', 'bash', {}),
    ])
    const param = assistantMessageToMessageParam(
      msg as unknown as Parameters<typeof assistantMessageToMessageParam>[0],
      true,
      true,
    )
    const content = wireContent(param)
    expect(content[0]).not.toHaveProperty('cache_control')
    expect(content[1]).toEqual({
      type: 'tool_use',
      id: 't1',
      name: 'bash',
      input: {},
      cache_control: { type: 'ephemeral' },
    })
  })

  test('no marker when the last block is a thinking block', () => {
    const msg = assistantMsg([
      createTextBlock('Answer'),
      createThinkingBlock('hmm', 'sig_1'),
    ])
    const param = assistantMessageToMessageParam(
      msg as unknown as Parameters<typeof assistantMessageToMessageParam>[0],
      true,
      true,
    )
    const content = wireContent(param)
    expect(content).toEqual([
      { type: 'text', text: 'Answer' },
      { type: 'thinking', thinking: 'hmm', signature: 'sig_1' },
    ])
    expect(content[0]).not.toHaveProperty('cache_control')
    expect(content[1]).not.toHaveProperty('cache_control')
  })
})

// ============================================================================
// 3. addCacheBreakpoints: exactly-one-marker constraint
// ============================================================================

describe('wire boundary: addCacheBreakpoints', () => {
  test('marker on the last message only', () => {
    const msgs = [
      userMsg([createTextBlock('Hello')]),
      assistantMsg([createTextBlock('Hi')]),
    ]
    const params = addCacheBreakpoints(
      msgs as unknown as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      null,
      [],
      false,
    )
    const first = wireContent(params[0])
    const last = wireContent(params[1])
    expect(first[0]).not.toHaveProperty('cache_control')
    expect(last[0]).toEqual({
      type: 'text',
      text: 'Hi',
      cache_control: { type: 'ephemeral' },
    })
  })

  test('skipCacheWrite shifts the marker to the second-to-last message', () => {
    const msgs = [
      userMsg([createTextBlock('Hello')]),
      assistantMsg([createTextBlock('Hi')]),
    ]
    const params = addCacheBreakpoints(
      msgs as unknown as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      null,
      [],
      true,
    )
    const first = wireContent(params[0])
    const last = wireContent(params[1])
    expect(first[0]).toEqual({
      type: 'text',
      text: 'Hello',
      cache_control: { type: 'ephemeral' },
    })
    expect(last[0]).not.toHaveProperty('cache_control')
  })
})

// ============================================================================
// 4. Store → wire roundtrip losslessness for normalized content
// ============================================================================

describe('store → wire roundtrip (normalized content re-encodes losslessly)', () => {
  test('tool_use + thinking re-encode to the wire format the API consumes', () => {
    const raw = [
      {
        type: 'tool_use',
        id: 't1',
        name: 'bash',
        input: '{"command":"ls"}',
      },
      { type: 'thinking', thinking: 'hmm', signature: 'sig_1' },
    ] as unknown as AgentContentBlock[]
    const stored = normalizeContentFromAPI(raw, [])
    const reencoded = stored.map(agentBlockToAnthropic)
    expect(reencoded).toEqual([
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
      { type: 'thinking', thinking: 'hmm', signature: 'sig_1' },
    ])
  })

  test('citations survive store → wire and ride alongside the cache marker', () => {
    const citations = [
      {
        cited_text: 'quoted line',
        document_index: 0,
        document_title: 'doc.txt',
        start_char_index: 0,
        end_char_index: 11,
      },
    ]
    const stored = normalizeContentFromAPI(
      [{ type: 'text', text: 'quoted line', citations }] as unknown as AgentContentBlock[],
      [],
    )
    const param = userMessageToMessageParam(
      userMsg(stored) as unknown as Parameters<typeof userMessageToMessageParam>[0],
      true,
      true,
    )
    expect(param.content).toEqual([
      {
        type: 'text',
        text: 'quoted line',
        citations,
        cache_control: { type: 'ephemeral' },
      },
    ])
  })

  test('escape-hatch block survives store → wire verbatim', () => {
    const stored = normalizeContentFromAPI(
      [{ type: 'server_tool_use', id: 's1', name: 'mcp', input: '{"a":1}' }] as unknown as AgentContentBlock[],
      [],
    )
    const wire = stored.map(agentBlockToAnthropic)
    expect(wire).toEqual([
      { type: 'server_tool_use', id: 's1', name: 'mcp', input: { a: 1 } },
    ])
  })

  test('normalizeContentFromAPI is the inverse of wire conversion for modelable blocks', () => {
    const raw = {
      type: 'tool_use',
      id: 't1',
      name: 'bash',
      input: { command: 'ls' },
    }
    const stored = normalizeContentFromAPI(
      [raw] as unknown as AgentContentBlock[],
      [],
    )
    const roundtripped = anthropicBlockToAgent(
      agentBlockToAnthropic(stored[0]),
    )
    expect(roundtripped).toEqual(stored[0])
  })
})

// ============================================================================
// 5. Convergence: the store's inner semantic message IS the canonical
//    AgentMessage (message.ts derives from agentMessage.ts, no parallel
//    canonical types)
// ============================================================================

describe('convergence: canonical AgentMessage is the store inner message', () => {
  test('canonical AgentUserMessage flows through the wire builder as the store inner message', () => {
    const inner = createUserMessage([createTextBlock('hi')], UUID, TS)
    const wrapper = { type: 'user', message: inner, uuid: UUID, timestamp: TS }
    const param = userMessageToMessageParam(wrapper as never, true, true)
    expect(param).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'hi',
          cache_control: { type: 'ephemeral' },
        },
      ],
    })
  })

  test('canonical AgentAssistantMessage (thinking-last) flows through the wire builder', () => {
    const inner = createAssistantMessage(
      [createTextBlock('ans'), createThinkingBlock('hmm', 'sig')],
      UUID,
      TS,
    )
    const wrapper = {
      type: 'assistant',
      message: inner,
      uuid: UUID,
      timestamp: TS,
    }
    const param = assistantMessageToMessageParam(wrapper as never, true, true)
    expect(param.content).toEqual([
      { type: 'text', text: 'ans' },
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
    ])
  })

  test('store wrapper inner message carries the canonical semantic shape', () => {
    const wrapper = createStoreUserMessage({
      content: [createTextBlock('hi')],
      uuid: UUID,
      timestamp: new Date(TS).toISOString(),
    })
    expect(wrapper.type).toBe('user')
    expect(wrapper.message.role).toBe('user')
    expect(wrapper.message.content).toEqual([{ type: 'text', text: 'hi' }])
    // The wrapper inner message is structurally the canonical AgentUserMessage
    // (role + content) that the wire builders consume.
  })
})