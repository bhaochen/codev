import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { parseSSERaw } from '../transport/sse.js'
import {
  adaptOpenAIResponsesSSE,
  buildOpenAIResponsesBody,
  responsesUrl,
  type OpenAIResponsesStreamEvent,
} from './openaiResponses.js'
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import { createAssistantMessage, createUserMessage } from '../../../utils/messages.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import type { Tool } from '../../../Tool.js'

// ============================================================================
// Fixtures
// ============================================================================

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(enc.encode(chunks[i++]!))
    },
  })
}

async function collectEvents(chunks: string[], model = 'gpt-4o'): Promise<OpenAIResponsesStreamEvent[]> {
  const out: OpenAIResponsesStreamEvent[] = []
  for await (const ev of adaptOpenAIResponsesSSE(parseSSERaw(sseStream(chunks)), model)) {
    out.push(ev)
  }
  return out
}

function textDeltaChunks(deltas: string[], usage: string): string[] {
  return [
    ...deltas.map(d => `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":${JSON.stringify(d)}}\n\n`),
    `event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":${usage}}}\n\n`,
  ]
}

const baseRoute: LLMRoute = {
  provider: 'openai',
  protocol: 'openai-responses',
  model: 'gpt-4o',
  endpoint: 'https://api.openai.com/v1',
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  const context: LLMRequest['context'] = {
    model: 'gpt-4o',
    getToolPermissionContext: () => Promise.resolve({} as never),
    agents: [],
    isNonInteractiveSession: true,
    querySource: 'test',
    hasAppendSystemPrompt: true,
    mcpTools: [],
  }
  return {
    model: 'gpt-4o',
    messages: [],
    systemPrompt: asSystemPrompt([]),
    tools: [],
    signal: new AbortController().signal,
    config: {},
    context,
    ...overrides,
  }
}

function mockTool(name: string, desc = `Tool ${name}`, strict = false): Tool {
  return {
    name,
    ...(strict ? { strict: true } : {}),
    inputJSONSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    prompt: async () => desc,
  } as unknown as Tool
}

// ============================================================================
// URL helper
// ============================================================================

describe('responsesUrl', () => {
  test('normalizes overlapping /v1 prefixes', () => {
    expect(responsesUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/responses',
    )
    expect(responsesUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/responses',
    )
    expect(responsesUrl('https://example.com')).toBe(
      'https://example.com/v1/responses',
    )
  })
})

// ============================================================================
// Native SSE → stream events
// ============================================================================

describe('adaptOpenAIResponsesSSE', () => {
  test('text deltas accumulate into one block', async () => {
    const events = await collectEvents(
      textDeltaChunks(['Hello', ' world'], '{"input_tokens":10,"output_tokens":5}'),
    )
    const lines: string[] = []
    for (const ev of events) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        lines.push(ev.delta.text)
      }
    }
    expect(lines.join('')).toBe('Hello world')
  })

  test('full event lifecycle with end_turn', async () => {
    const events = await collectEvents(
      textDeltaChunks(['hi'], '{"input_tokens":1,"output_tokens":1}'),
    )
    const types = events.map(e => e.type)
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const delta = events.find(e => e.type === 'message_delta')!
    if (delta.type !== 'message_delta') throw new Error('expected message_delta')
    expect(delta.delta.stop_reason).toBe('end_turn')
    expect(delta.usage.input_tokens).toBe(1)
    expect(delta.usage.output_tokens).toBe(1)
  })

  test('cross-chunk delta framing survives split JSON', async () => {
    const events = await collectEvents([
      'event: response.output_text.delta\ndata: {"type":"response.output_text',
      '.delta","item_id":"msg_1","content_index":0,"delta":"cross"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    const text = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? [e.delta.text] : [],
      )
      .join('')
    expect(text).toBe('cross')
  })

  test('response.created and unknown events do not crash', async () => {
    const events = await collectEvents([
      'event: response.created\ndata: {"type":"response.created","response":{}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"ok"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    const text = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? [e.delta.text] : [],
      )
      .join('')
    expect(text).toBe('ok')
  })

  test('invalid JSON data is skipped', async () => {
    const events = await collectEvents([
      'event: response.output_text.delta\ndata: not-json\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"good"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    const text = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? [e.delta.text] : [],
      )
      .join('')
    expect(text).toBe('good')
  })

  test('message_start carries stable id (response.id passed through)', async () => {
    const events = await collectEvents([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_abc"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_abc","status":"completed"}}\n\n',
    ])
    const start = events.find(e => e.type === 'message_start')!
    if (start.type !== 'message_start') throw new Error('expected message_start')
    expect(start.message.id).toBe('resp_abc')
  })

  test('tool call streams input_json_delta and closes at output_item.done', async () => {
    const events = await collectEvents([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"mock_tool","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"path\\":"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"/tmp/x\\"}"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":0,"arguments":"{\\"path\\":\\"/tmp/x\\"}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"mock_tool","arguments":"{\\"path\\":\\"/tmp/x\\"}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    const start = events.find(e => e.type === 'content_block_start')!
    if (start.type !== 'content_block_start') throw new Error('expected content_block_start')
    expect(start.content_block).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'mock_tool',
      input: '',
    })
    const jsonDelta = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'input_json_delta'
          ? [e.delta.partial_json]
          : [],
      )
      .join('')
    expect(jsonDelta).toBe('{"path":"/tmp/x"}')
    const stopIdx = events
      .filter(e => e.type === 'content_block_stop')
      .map(e => (e.type === 'content_block_stop' ? e.index : -1))
    expect(stopIdx).toEqual([0])
  })

  test('parallel tool calls produce distinct tool_use blocks', async () => {
    const events = await collectEvents([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"tool_a"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"tool_b"}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"tool_a","arguments":"{}"}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"tool_b","arguments":"{}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    const ids = events
      .filter(e => e.type === 'content_block_start')
      .map(e => (e.type === 'content_block_start' ? (e.content_block as { id: string }).id : ''))
    expect(ids).toEqual(['call_1', 'call_2'])
  })

  test('function_call with full args only in output_item.done (non-streamed)', async () => {
    const events = await collectEvents([
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"mock_tool","arguments":"{\\"path\\":\\"/tmp/x\\"}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    const blocks = events.filter(e => e.type === 'content_block_start')
    expect(blocks.length).toBe(1)
    const jsonDelta = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'input_json_delta'
          ? [e.delta.partial_json]
          : [],
      )
      .join('')
    expect(jsonDelta).toBe('{"path":"/tmp/x"}')
    const stopped = events.some(e => e.type === 'content_block_stop')
    expect(stopped).toBe(true)
  })

  test('reasoning summary becomes a thinking block without signature', async () => {
    const events = await collectEvents([
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"reasoning","summary":[]}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"msg_1","output_index":0,"summary_index":0,"text":"Let me think"}\n\n',
      'event: response.reasoning_summary_text.done\ndata: {"type":"response.reasoning_summary_text.done","item_id":"msg_1","output_index":0,"summary_index":0,"text":"Let me think"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":1,"delta":"Answer"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Let me think"}]},{"type":"output_text","text":"Answer","annotations":[]}]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":4,"output_tokens_details":{"reasoning_tokens":6}}}}\n\n',
    ])
    const start = events.find(
      e => e.type === 'content_block_start' && e.content_block.type === 'thinking',
    )!
    if (start.type !== 'content_block_start') throw new Error('expected thinking block')
    expect('signature' in start.content_block).toBe(false)
    const thinking = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'thinking_delta'
          ? [e.delta.thinking]
          : [],
      )
      .join('')
    expect(thinking).toBe('Let me think')
  })

  test('incomplete status maps to max_tokens stop_reason', async () => {
    const events = await collectEvents([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"partial"}\n\n',
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":2,"output_tokens":1000}}}\n\n',
    ])
    const delta = events.find(e => e.type === 'message_delta')!
    if (delta.type !== 'message_delta') throw new Error('expected message_delta')
    expect(delta.delta.stop_reason).toBe('max_tokens')
    expect(delta.usage.output_tokens).toBe(1000)
  })

  test('usage includes reasoning_tokens from output_tokens_details', async () => {
    const events = await collectEvents(
      textDeltaChunks(['x'], '{"input_tokens":7,"output_tokens":9,"output_tokens_details":{"reasoning_tokens":5}}'),
    )
    const delta = events.find(e => e.type === 'message_delta')!
    if (delta.type !== 'message_delta') throw new Error('expected message_delta')
    expect(delta.usage.output_tokens_details?.reasoning_tokens).toBe(5)
  })

  test('empty stream ends without emitting synthetic events', async () => {
    const events = await collectEvents([])
    expect(events.length).toBe(0)
  })
})

// ============================================================================
// Native request body builder
// ============================================================================

describe('buildOpenAIResponsesBody', () => {
  test('text-only messages map to native input items', async () => {
    const request = makeRequest({
      systemPrompt: asSystemPrompt(['You are helpful.']),
      messages: [createUserMessage({ content: 'Hello' })],
    })
    const body = await buildOpenAIResponsesBody(baseRoute, request)
    expect(body.model).toBe('gpt-4o')
    expect(body.instructions).toBe('You are helpful.')
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    expect(body.max_output_tokens).toBeTypeOf('number')
    expect(body.prompt_cache_key).toMatch(/^ccb:/)
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ])
  })

  test('tool call → tool result round-trips through call_id', async () => {
    const tool = mockTool('mock_tool')
    const request = makeRequest({
      tools: [tool],
      messages: [
        createUserMessage({ content: 'Do it' }),
        createAssistantMessage({
          content: [
            { type: 'text', text: 'Looking up' },
            { type: 'tool_use', id: 'toolu_1', name: 'mock_tool', input: { path: '/tmp/x' } },
          ],
        }),
        createUserMessage({
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: '{"ok":true}',
              is_error: false,
            },
          ],
        }),
      ],
    })
    const body = await buildOpenAIResponsesBody(baseRoute, request)
    const items = body.input
    expect(items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do it' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Looking up' }],
      },
      {
        type: 'function_call',
        call_id: 'toolu_1',
        id: 'toolu_1',
        name: 'mock_tool',
        arguments: '{"path":"/tmp/x"}',
      },
      {
        type: 'function_call_output',
        call_id: 'toolu_1',
        output: '{"ok":true}',
      },
    ])
  })

  test('thinking block maps to reasoning summary part (no signature fake)', async () => {
    const request = makeRequest({
      messages: [
        createAssistantMessage({
          content: [
            { type: 'thinking', thinking: 'let me think' },
            { type: 'text', text: 'The answer' },
          ],
        }),
      ],
    })
    const body = await buildOpenAIResponsesBody(baseRoute, request)
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'The answer' },
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'let me think' }],
          },
        ],
      },
    ])
  })

  test('tools become flat native function tools with const→enum sanitization', async () => {
    const tool = {
      name: 'mock_tool',
      inputJSONSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', const: 'fast' },
          path: { type: 'string' },
        },
        required: ['path'],
      },
      prompt: async () => 'Does things',
    } as unknown as Tool
    const request = makeRequest({ tools: [tool] })
    const body = await buildOpenAIResponsesBody(baseRoute, request)
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'mock_tool',
        description: 'Does things',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['fast'] },
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    ])
  })

  test('tool_choice maps auto/any/tool to native forms', async () => {
    const tool = mockTool('mock_tool')
    const auto = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      tools: [tool],
      config: { toolChoice: { type: 'auto' } },
    }))
    expect(auto.tool_choice).toBe('auto')
    const any = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      tools: [tool],
      config: { toolChoice: { type: 'any' } },
    }))
    expect(any.tool_choice).toBe('required')
    const named = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      tools: [tool],
      config: { toolChoice: { type: 'tool', name: 'mock_tool' } },
    }))
    expect(named.tool_choice).toEqual({ type: 'function', name: 'mock_tool' })
  })

  test('disable_parallel_tool_use emits parallel_tool_calls:false', async () => {
    const tool = mockTool('mock_tool')
    const body = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      tools: [tool],
      config: { toolChoice: { type: 'auto', disable_parallel_tool_use: true } },
    }))
    expect(body.tools![0]!.parallel_tool_calls).toBe(false)
  })

  test('reasoning effort maps and disabled omits the field', async () => {
    // string effort value → native level
    const high = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      config: {},
      context: {
        ...makeRequest().context,
        effortValue: 'high',
      },
    }))
    expect(high.reasoning).toEqual({ effort: 'high' })

    const medium = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      context: {
        ...makeRequest().context,
        effortValue: 'medium',
      },
    }))
    expect(medium.reasoning).toEqual({ effort: 'medium' })

    // thinking enabled without effort → high
    const thinking = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      config: { thinking: { type: 'enabled', budgetTokens: 512 } },
    }))
    expect(thinking.reasoning).toEqual({ effort: 'high' })

    // disabled → omits reasoning entirely (non-reasoning models reject the field)
    const disabled = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      config: { thinking: { type: 'disabled' } },
      context: { ...makeRequest().context, effortValue: 'high' },
    }))
    expect(disabled.reasoning).toBeUndefined()

    // no signal at all → omits reasoning
    const none = await buildOpenAIResponsesBody(baseRoute, makeRequest({}))
    expect(none.reasoning).toBeUndefined()
  })

  test('numeric effort is skipped (1P-Anthropic-only semantic)', async () => {
    const body = await buildOpenAIResponsesBody(baseRoute, makeRequest({
      context: { ...makeRequest().context, effortValue: 5 as never },
    }))
    expect(body.reasoning).toBeUndefined()
  })
})

// ============================================================================
// Import audit: openaiResponses.ts stays native (no Anthropic wire shapes)
// ============================================================================

describe('openaiResponses native-only invariant', () => {
  const source = readFileSync('src/services/llm/protocols/openaiResponses.ts', 'utf8')
  const banned = [
    'toAnthropicMessage',
    'convertAnthropicMessagesToOpenAI',
    'convertAnthropicToolsToOpenAI',
    'anthropicToolChoiceToOpenAI',
    'adaptOpenAIResponsesSSEToAnthropic',
    'import type { Options }',
  ]
  for (const needle of banned) {
    test(`does not reference ${needle}`, () => {
      expect(source).not.toContain(needle)
    })
  }
  for (const needle of ['BetaMessageParam', 'BetaMessage', 'BetaUsage', 'BetaStopReason', 'BetaToolUnion']) {
    test(`does not import Anthropic SDK message type ${needle}`, () => {
      expect(source).not.toContain(needle)
    })
  }
  test('does not import @ant/model-provider', () => {
    expect(source).not.toContain('@ant/model-provider')
  })
  test('only @anthropic-ai/sdk import is the abort-error class', () => {
    expect(source).not.toContain("@anthropic-ai/sdk'")
    expect(source).not.toContain('@anthropic-ai/sdk/resources')
    expect(source).toContain("@anthropic-ai/sdk/error'")
  })
})