import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { parseOpenAIChunksFromSSE } from '../transport/sse.js'
import {
  adaptOpenAIChatSSE,
  agentMessagesToOpenAIChatMessages,
  buildOpenAIChatBody,
  chatCompletionsUrlFromBase,
  extractOpenAIChatReasoningText,
  isOpenAIChatThinkingEnabled,
  openAIChatToolChoiceFromLLM,
  openAIChatToolsFromSchemas,
  resolveOpenAIChatThinking,
  type OpenAIChatStreamEvent,
} from './openaiChatWire.js'
import type { LLMRequest } from '../runtime/types.js'
import type { LLMRoute } from '../types.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'

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

async function collectEvents(chunks: string[], model = 'gpt-4o'): Promise<OpenAIChatStreamEvent[]> {
  const out: OpenAIChatStreamEvent[] = []
  for await (const ev of adaptOpenAIChatSSE(parseOpenAIChunksFromSSE(sseStream(chunks)), model, { includeCacheWriteTokens: false })) {
    out.push(ev)
  }
  return out
}

function chatDelta(event: string, json: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(json)}\n\n`
}

function textChunks(deltas: string[], finish: string, usage?: Record<string, unknown>): string[] {
  const chunks = deltas.map(d =>
    chatDelta(
      'chat.completion.chunk',
      {
        id: 'chatcmpl_1',
        choices: [{ delta: { content: d }, index: 0 }],
      },
    ),
  )
  chunks.push(
    chatDelta('chat.completion.chunk', {
      id: 'chatcmpl_1',
      choices: [{ delta: {}, index: 0, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    }),
  )
  return chunks
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

function wrapperUser(content: unknown): never {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: 'u1',
    timestamp: 1,
  } as never
}

function wrapperAssistant(content: unknown): never {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    uuid: 'a1',
    timestamp: 1,
  } as never
}

// ============================================================================
// URL helper
// ============================================================================

describe('chatCompletionsUrlFromBase', () => {
  test('appends /v1/chat/completions to bare bases', () => {
    expect(chatCompletionsUrlFromBase('https://example.com')).toBe(
      'https://example.com/v1/chat/completions',
    )
    expect(chatCompletionsUrlFromBase('https://example.com/')).toBe(
      'https://example.com/v1/chat/completions',
    )
  })

  test('keeps existing /v1 prefix single', () => {
    expect(chatCompletionsUrlFromBase('https://example.com/v1')).toBe(
      'https://example.com/v1/chat/completions',
    )
    expect(chatCompletionsUrlFromBase('https://example.com/v1/')).toBe(
      'https://example.com/v1/chat/completions',
    )
  })
})

// ============================================================================
// Request body
// ============================================================================

describe('buildOpenAIChatBody', () => {
  const base = { model: 'gpt-4o', messages: [] as never[], maxTokens: 4096, enableThinking: false }

  test('base shape with stream options', () => {
    expect(buildOpenAIChatBody(base)).toEqual({
      model: 'gpt-4o',
      messages: [],
      max_tokens: 4096,
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  test('tools + tool_choice only when tools present', () => {
    const body = buildOpenAIChatBody(base)
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()

    const withTools = buildOpenAIChatBody({
      ...base,
      tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
      toolChoice: 'auto',
    })
    expect((withTools.tools as unknown[]).length).toBe(1)
    expect(withTools.tool_choice).toBe('auto')
  })

  test('prompt_cache_key passes through', () => {
    const body = buildOpenAIChatBody({ ...base, promptCacheKey: 'ccb:abc' })
    expect(body.prompt_cache_key).toBe('ccb:abc')
  })

  test('thinking fans out three formats + reasoning_effort, omits temperature', () => {
    const body = buildOpenAIChatBody({
      model: 'deepseek-chat',
      messages: [],
      enableThinking: true,
      reasoningEffort: 'high',
      maxTokens: 1000,
      temperatureOverride: 0.7,
    })
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.enable_thinking).toBe(true)
    expect(body.chat_template_kwargs).toEqual({ thinking: true, enable_thinking: true })
    expect(body.reasoning_effort).toBe('high')
    expect(body.temperature).toBeUndefined()
  })

  test('temperature sent only when thinking is off', () => {
    const body = buildOpenAIChatBody({ ...base, temperatureOverride: 0.2 })
    expect(body.temperature).toBe(0.2)
    const thinking = buildOpenAIChatBody({ ...base, enableThinking: true, temperatureOverride: 0.2 })
    expect(thinking.temperature).toBeUndefined()
  })
})

// ============================================================================
// Reasoning config
// ============================================================================

describe('resolveOpenAIChatThinking', () => {
  test('disabled forces off even for detected models', () => {
    const req = makeRequest({ config: { thinking: { type: 'disabled' } } })
    expect(resolveOpenAIChatThinking('deepseek-chat', req.config, req.context)).toEqual({
      enableThinking: false,
    })
  })

  test('enabled forces on and effortValue maps to reasoning_effort', () => {
    const req = makeRequest({
      config: { thinking: { type: 'enabled', budgetTokens: 1024 } },
      context: { ...makeRequest().context, effortValue: 'high' },
    })
    expect(resolveOpenAIChatThinking('gpt-4o', req.config, req.context)).toEqual({
      enableThinking: true,
      reasoning_effort: 'high',
    })
  })

  test('xhigh/max collapse to high', () => {
    const ctx = { ...makeRequest().context, effortValue: 'max' as const }
    expect(resolveOpenAIChatThinking('deepseek-chat', {} as never, ctx)).toEqual({
      enableThinking: true,
      reasoning_effort: 'high',
    })
  })

  test('numeric effort is not mapped', () => {
    const ctx = { ...makeRequest().context, effortValue: 5 }
    expect(resolveOpenAIChatThinking('deepseek-chat', {} as never, ctx)).toEqual({
      enableThinking: true,
    })
  })

  test('effort only rides along when thinking is enabled', () => {
    const req = makeRequest({ config: { thinking: { type: 'disabled' } } })
    const withEffort = { ...req.context, effortValue: 'high' as const }
    expect(resolveOpenAIChatThinking('gpt-4o', req.config, withEffort)).toEqual({
      enableThinking: false,
    })
  })

  test('model-name auto-detection for deepseek/mimo, grok excluded', () => {
    expect(isOpenAIChatThinkingEnabled('deepseek-reasoner')).toBe(true)
    expect(isOpenAIChatThinkingEnabled('mimo-v2.5-max')).toBe(true)
    expect(isOpenAIChatThinkingEnabled('grok-4')).toBe(false)
    expect(resolveOpenAIChatThinking('deepseek-chat', {} as never, makeRequest().context)).toEqual({
      enableThinking: true,
    })
  })
})

// ============================================================================
// Message conversion
// ============================================================================

describe('agentMessagesToOpenAIChatMessages', () => {
  test('system prompt becomes leading system message', () => {
    const msgs = agentMessagesToOpenAIChatMessages(
      [wrapperUser([{ type: 'text', text: 'hi' }])],
      'You are helpful',
    )
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are helpful' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'hi' })
  })

  test('string user content passes through', () => {
    const msgs = agentMessagesToOpenAIChatMessages([wrapperUser('hi')])
    expect(msgs).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('multi text blocks become a parts array (legacy parity)', () => {
    const msgs = agentMessagesToOpenAIChatMessages([
      wrapperUser([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    ])
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ])
  })

  test('image becomes image_url part array', () => {
    const msgs = agentMessagesToOpenAIChatMessages([
      wrapperUser([
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]),
    ])
    expect(msgs[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    })
  })

  test('tool_result emits tool message before user message', () => {
    const msgs = agentMessagesToOpenAIChatMessages([
      wrapperUser([
        { type: 'tool_result', tool_use_id: 'call_1', content: 'ok', is_error: false },
        { type: 'text', text: 'now what' },
      ]),
    ])
    expect(msgs).toEqual([
      { role: 'tool', content: 'ok', tool_call_id: 'call_1' },
      { role: 'user', content: 'now what' },
    ])
  })

  test('tool_result array content with image → parts (supportsImages), text-only otherwise', () => {
    const input = [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'text', text: 'out' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
        ],
      },
    ]
    const withImage = agentMessagesToOpenAIChatMessages([wrapperUser(input)])
    expect(withImage[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: 'out' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
      ],
    })

    const noImage = agentMessagesToOpenAIChatMessages([wrapperUser(input)], undefined, {
      supportsImages: false,
    })
    expect(noImage[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'out' })
  })

  test('assistant text joins and empty content becomes null', () => {
    const msgs = agentMessagesToOpenAIChatMessages([
      wrapperAssistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    ])
    expect(msgs[0].content).toBe('a\nb')
    const empty = agentMessagesToOpenAIChatMessages([wrapperAssistant([])])
    expect(empty[0].content).toBeNull()
  })

  test('tool_use → tool_calls with JSON-stringified args', () => {
    const msgs = agentMessagesToOpenAIChatMessages([
      wrapperAssistant([
        { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
      ]),
    ])
    expect(msgs[0].tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
    ])
  })

  test('string tool input passes through unstringified', () => {
    const msgs = agentMessagesToOpenAIChatMessages([
      wrapperAssistant([{ type: 'tool_use', id: 'call_1', name: 'x', input: 'raw' }]),
    ])
    expect(msgs[0].tool_calls?.[0]!.function.arguments).toBe('raw')
  })

  test('thinking → reasoning_content, empty string preserved', () => {
    const msgs = agentMessagesToOpenAIChatMessages([
      wrapperAssistant([{ type: 'thinking', thinking: 'let me think' }, { type: 'text', text: 'ans' }]),
    ])
    expect(msgs[0].reasoning_content).toBe('let me think')
    expect(msgs[0].content).toBe('ans')

    const emptyThinking = agentMessagesToOpenAIChatMessages([
      wrapperAssistant([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'ans' }]),
    ])
    expect(emptyThinking[0].reasoning_content).toBe('')
  })

  test('consecutive assistant messages merge', () => {
    const msgs = agentMessagesToOpenAIChatMessages([
      wrapperAssistant([{ type: 'text', text: 'one' }]),
      wrapperAssistant([{ type: 'text', text: 'two' }]),
    ])
    expect(msgs).toEqual([{ role: 'assistant', content: 'one\ntwo' }])
  })
})

// ============================================================================
// Tools
// ============================================================================

describe('openAIChatToolsFromSchemas', () => {
  test('optional fields default like the legacy converter', () => {
    const tools = openAIChatToolsFromSchemas([{ name: 'bare' }])
    expect(tools).toEqual([
      {
        type: 'function',
        function: { name: 'bare', description: '', parameters: { type: 'object', properties: {} } },
      },
    ])
  })

  test('const → enum recursive sanitize (properties + anyOf)', () => {
    const tools = openAIChatToolsFromSchemas([
      {
        name: 't',
        description: 'd',
        input_schema: {
          type: 'object',
          properties: {
            mode: { const: 'fast' },
            nested: { anyOf: [{ const: 1 }, { properties: { a: { const: 'x' } } }] },
          },
          required: ['mode'],
        },
      },
    ])
    expect(tools[0]!.function.parameters).toEqual({
      type: 'object',
      properties: {
        mode: { enum: ['fast'] },
        nested: { anyOf: [{ enum: [1] }, { properties: { a: { enum: ['x'] } } }] },
      },
      required: ['mode'],
    })
  })

  test('items const is sanitized', () => {
    const tools = openAIChatToolsFromSchemas([
      { name: 't', input_schema: { type: 'array', items: { const: 'v' } } },
    ])
    expect(tools[0]!.function.parameters).toEqual({
      type: 'array',
      items: { enum: ['v'] },
    })
  })
})

describe('openAIChatToolChoiceFromLLM', () => {
  test.each([
    [{ type: 'auto' }, 'auto'],
    [{ type: 'any' }, 'required'],
    [{ type: 'tool', name: 'bash' }, { type: 'function', function: { name: 'bash' } }],
    [undefined, undefined],
    [{ type: 'nonsense' }, undefined],
  ] as const)('%o → %o', (choice, expected) => {
    expect(openAIChatToolChoiceFromLLM(choice)).toEqual(expected)
  })
})

// ============================================================================
// Reasoning extraction
// ============================================================================

describe('extractOpenAIChatReasoningText', () => {
  test('precedence: reasoning_content ?? reasoning ?? reasoning_text ?? details', () => {
    expect(extractOpenAIChatReasoningText({ reasoning_content: 'a', reasoning: 'b' })).toBe('a')
    expect(extractOpenAIChatReasoningText({ reasoning: 'b', reasoning_text: 'c' })).toBe('b')
    expect(extractOpenAIChatReasoningText({ reasoning_text: 'c' })).toBe('c')
    expect(extractOpenAIChatReasoningText({ reasoning_details: [{ text: 'x' }, { text: 'y' }] })).toBe('xy')
  })

  test('empty string is a valid signal', () => {
    expect(extractOpenAIChatReasoningText({ reasoning_content: '' })).toBe('')
    expect(extractOpenAIChatReasoningText({ reasoning_content: null, reasoning_text: '' })).toBe('')
  })

  test('nullish carrier yields null', () => {
    expect(extractOpenAIChatReasoningText(null)).toBeNull()
    expect(extractOpenAIChatReasoningText({})).toBeNull()
  })
})

// ============================================================================
// SSE adapter
// ============================================================================

describe('adaptOpenAIChatSSE', () => {
  test('text lifecycle with end_turn', async () => {
    const events = await collectEvents(textChunks(['Hello', ' world'], 'stop'))
    const types = events.map(e => e.type)
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const delta = events.find(e => e.type === 'message_delta')!
    if (delta.type !== 'message_delta') throw new Error('expected message_delta')
    expect(delta.delta.stop_reason).toBe('end_turn')
  })

  test('message_start carries id, model, zeroed usage', async () => {
    const events = await collectEvents(textChunks(['x'], 'stop'))
    const start = events.find(e => e.type === 'message_start')!
    if (start.type !== 'message_start') throw new Error('expected message_start')
    expect(start.message.id).toMatch(/^msg_[0-9a-f]{24}$/)
    expect(start.message.model).toBe('gpt-4o')
    expect(start.message.content).toEqual([])
    expect(start.message.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  test('no finish_reason → no message_delta/message_stop', async () => {
    const events = await collectEvents([
      chatDelta('chat.completion.chunk', { id: 'c', choices: [{ delta: { content: 'x' }, index: 0 }] }),
    ])
    expect(events.map(e => e.type)).toContain('content_block_delta')
    expect(events.map(e => e.type)).not.toContain('message_delta')
    expect(events.map(e => e.type)).not.toContain('message_stop')
  })

  test('reasoning maps to thinking block without signature', async () => {
    const events = await collectEvents([
      chatDelta('chat.completion.chunk', {
        id: 'c',
        choices: [{ delta: { reasoning_content: 'thinking hard' }, index: 0 }],
      }),
      ...textChunks(['answer'], 'stop'),
    ])
    const start = events.find(e => e.type === 'content_block_start')!
    if (start.type !== 'content_block_start') throw new Error('expected content_block_start')
    expect(start.content_block).toEqual({ type: 'thinking', thinking: '' })
    expect('signature' in start.content_block).toBe(false)
    const thoughts = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'thinking_delta' ? [e.delta.thinking] : [],
      )
      .join('')
    expect(thoughts).toBe('thinking hard')
  })

  test('empty reasoning_content still opens a thinking block', async () => {
    const events = await collectEvents([
      chatDelta('chat.completion.chunk', {
        id: 'c',
        choices: [{ delta: { reasoning_content: '' }, index: 0 }],
      }),
      ...textChunks(['ans'], 'stop'),
    ])
    const starts = events.filter(e => e.type === 'content_block_start')
    expect(starts.length).toBe(2)
    if (starts[0]!.type !== 'content_block_start') throw new Error('expected start')
    expect(starts[0]!.content_block).toEqual({ type: 'thinking', thinking: '' })
  })

  test('web-reasoning variants reasoning / reasoning_text / reasoning_details', async () => {
    for (const [field, value] of [
      ['reasoning', 'r1'],
      ['reasoning_text', 'r2'],
      ['reasoning_details', [{ text: 'r3' }]],
    ] as const) {
      const events = await collectEvents([
        chatDelta('chat.completion.chunk', {
          id: 'c',
          choices: [{ delta: { [field]: value }, index: 0 }],
        }),
        ...textChunks(['z'], 'stop'),
      ])
      const thoughts = events
        .flatMap(e =>
          e.type === 'content_block_delta' && e.delta.type === 'thinking_delta' ? [e.delta.thinking] : [],
        )
        .join('')
      expect(thoughts).toBe(field === 'reasoning_details' ? 'r3' : value)
    }
  })

  test('tool_calls stream input_json_delta and close at finish', async () => {
    const events = await collectEvents([
      chatDelta('chat.completion.chunk', {
        id: 'c',
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"c' } }] },
          index: 0,
        }],
      }),
      chatDelta('chat.completion.chunk', {
        id: 'c',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ommand":"ls"}' } }] }, index: 0 }],
      }),
      chatDelta('chat.completion.chunk', {
        id: 'c',
        choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }],
      }),
    ])
    const start = events.find(e => e.type === 'content_block_start')!
    if (start.type !== 'content_block_start') throw new Error('expected start')
    expect(start.content_block).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'bash',
      input: {},
    })
    const json = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'input_json_delta' ? [e.delta.partial_json] : [],
      )
      .join('')
    expect(json).toBe('{"command":"ls"}')
    const delta = events.find(e => e.type === 'message_delta')!
    if (delta.type !== 'message_delta') throw new Error('expected message_delta')
    expect(delta.delta.stop_reason).toBe('tool_use')
  })

  test('missing tool index and id get fallbacks', async () => {
    const events = await collectEvents([
      chatDelta('chat.completion.chunk', {
        id: 'c',
        choices: [{ delta: { tool_calls: [{ function: { name: 'bare' } }] }, index: 0 }],
      }),
      chatDelta('chat.completion.chunk', {
        id: 'c',
        choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }],
      }),
    ])
    const start = events.find(e => e.type === 'content_block_start')!
    if (start.type !== 'content_block_start') throw new Error('expected start')
    expect((start.content_block as { id: string }).id).toMatch(/^toolu_/)
    expect((start.content_block as { name: string }).name).toBe('bare')
  })

  test('finish_reason length → max_tokens; content_filter → end_turn', async () => {
    const long = await collectEvents(textChunks(['x'], 'length', { prompt_tokens: 10, completion_tokens: 300 }))
    const longDelta = long.find(e => e.type === 'message_delta')!
    if (longDelta.type !== 'message_delta') throw new Error('expected delta')
    expect(longDelta.delta.stop_reason).toBe('max_tokens')

    const filtered = await collectEvents(textChunks(['x'], 'content_filter'))
    const filteredDelta = filtered.find(e => e.type === 'message_delta')!
    if (filteredDelta.type !== 'message_delta') throw new Error('expected delta')
    expect(filteredDelta.delta.stop_reason).toBe('end_turn')
  })

  test('usage normalization: cached → cache_read, cache_write ignored', async () => {
    const events = await collectEvents(
      textChunks(['x'], 'stop', {
        prompt_tokens: 100,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 40 },
      }),
    )
    const delta = events.find(e => e.type === 'message_delta')!
    if (delta.type !== 'message_delta') throw new Error('expected delta')
    expect(delta.usage).toEqual({
      input_tokens: 40,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 60,
    })
  })

  test('trailing usage chunk after finish is captured', async () => {
    const events = await collectEvents([
      ...textChunks(['x'], 'stop'),
      chatDelta('chat.completion.chunk', {
        id: 'c',
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 7 },
      }),
    ])
    const delta = events.find(e => e.type === 'message_delta')!
    if (delta.type !== 'message_delta') throw new Error('expected delta')
    expect(delta.usage.output_tokens).toBe(7)
    expect(delta.usage.input_tokens).toBe(50)
  })

  test('unknown fields and [DONE] do not crash', async () => {
    const events = await collectEvents([
      chatDelta('chat.completion.chunk', { id: 'c', choices: [{ delta: { role: 'assistant' }, index: 0 }] }),
      chatDelta('chat.completion.chunk', { id: 'c', choices: [{ delta: { content: 'ok' }, index: 0 }] }),
      chatDelta('chat.completion.chunk', { id: 'c', choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ])
    const text = events
      .flatMap(e =>
        e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? [e.delta.text] : [],
      )
      .join('')
    expect(text).toBe('ok')
  })
})

// ============================================================================
// Import-audit invariants (native Chat protocol must not touch legacy conversion)
// ============================================================================

describe('native OpenAI Chat protocol boundary', () => {
  const nativeFiles = {
    wire: 'src/services/llm/protocols/openaiChatWire.ts',
    client: 'src/services/llm/clients/openaiChat.ts',
    compatible: 'src/services/llm/protocols/openaiCompatibleChat.ts',
  }

  for (const [key, file] of Object.entries(nativeFiles)) {
    test(`${key}: chat protocol files do not import legacy conversion helpers`, () => {
      const s = readFileSync(file, 'utf8')
      for (const banned of [
        `from '@ant/model-provider'`,
        `from '@anthropic-ai/sdk/resources/beta`,
        `from '@anthropic-ai/sdk'`,
      ]) {
        expect(s).not.toContain(banned)
      }
      for (const helper of [
        'convertAnthropicMessagesToOpenAI',
        'adaptOpenAIStreamToAnthropic',
        'convertAnthropicToolsToOpenAI',
        'anthropicToolChoiceToOpenAI',
        'BetaMessage',
        'BetaToolUnion',
        'BetaUsage',
        'BetaStopReason',
        'AnthropicMessage',
      ]) {
        expect(s).not.toContain(helper)
      }
    })
  }

  test('wire module exposes the native surface', () => {
    const s = readFileSync(nativeFiles.wire, 'utf8')
    expect(s).toContain('export async function* adaptOpenAIChatSSE')
    expect(s).toContain('export function buildOpenAIChatBody')
    expect(s).toContain('export function agentMessagesToOpenAIChatMessages')
    expect(s).toContain('export function isOpenAIChatThinkingEnabled')
  })
})

// ============================================================================
// Route contract (names preserved)
// ============================================================================

test('query handler names stay stable for registry', async () => {
  const { queryOpenAIChat } = await import('../clients/openaiChat.js')
  const { queryOpenAICompatibleChat } = await import('./openaiCompatibleChat.js')
  expect(queryOpenAIChat.name).toBe('queryOpenAIChat')
  expect(queryOpenAICompatibleChat.name).toBe('queryOpenAICompatibleChat')
})

// ============================================================================
// Integration through queryOpenAIChat (no tools)
// ============================================================================

describe('queryOpenAIChat integration', () => {
  const route: LLMRoute = {
    provider: 'local',
    protocol: 'openai-chat',
    model: 'gpt-4o',
    endpoint: 'https://example.com',
  }

  function fakeFetch(chunks: string[]): () => Promise<Response> {
    return async () =>
      new Response(sseStream(chunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
  }

  test('full stream → assistant messages + stream events + usage', async () => {
    const { queryOpenAIChat } = await import('../clients/openaiChat.js')
    const req = makeRequest({
      messages: [wrapperUser([{ type: 'text', text: 'hi' }])],
      systemPrompt: asSystemPrompt(['sys']),
      context: { ...makeRequest().context, fetchOverride: fakeFetch(textChunks(['hello'], 'stop', { prompt_tokens: 9, completion_tokens: 3 })) as never },
    })
    const events: string[] = []
    const assistant: Array<{ type: string; message?: { role?: string } }> = []
    for await (const raw of queryOpenAIChat(route, req)) {
      const out = raw as {
        type: string
        event?: { type: string }
        apiError?: string
        message?: unknown
      }
      if (out.type === 'stream_event') events.push(out.event!.type)
      else if (out.type === 'assistant') assistant.push(out)
      else events.push(`error:${out.apiError}`)
    }
    expect(events).toContain('message_start')
    expect(events).toContain('content_block_delta')
    expect(events).toContain('message_delta')
    expect(events).toContain('message_stop')
    expect(assistant.length).toBe(1)
    const msg = assistant[0]!
    const inner = msg.message as unknown as { content: Array<{ type: string; text: string }> }
    expect(inner.content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  test('request body reaches the wire with native shape', async () => {
    const { queryOpenAIChat } = await import('../clients/openaiChat.js')
    let capturedBody: string | null = null
    const fetchOverride = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      capturedBody = String(init?.body)
      return new Response(sseStream(textChunks(['hi'], 'stop')), { status: 200 })
    }
    const req = makeRequest({
      messages: [wrapperUser([{ type: 'text', text: 'hi' }])],
      systemPrompt: asSystemPrompt(['sys']),
      context: { ...makeRequest().context, fetchOverride: fetchOverride as never },
    })
    for await (const _ of queryOpenAIChat(route, req)) { /* drain */ }
    const body = JSON.parse(capturedBody!) as Record<string, unknown>
    expect(body.model).toBe('gpt-4o')
    expect(body.stream).toBe(true)
    expect((body.messages as Array<{ role: string }>)[0]!.role).toBe('system')
    expect((body.messages as Array<{ role: string }>)[1]!.role).toBe('user')
  })
})