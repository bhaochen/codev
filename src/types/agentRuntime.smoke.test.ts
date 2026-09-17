import { describe, test, expect } from 'bun:test'
import type {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  createAssistantMessage,
  createThinkingBlock,
  createToolUseBlock,
  createTextBlock,
  type AgentContentBlock,
} from './agentMessage.js'
import {
  createUserMessage as createStoreUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../utils/messages.js'
import {
  addCacheBreakpoints,
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from '../services/llm/clients/anthropicMessages.js'
import { SyntheticOutputTool } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { processPreMappedToolResultBlock } from '../utils/toolResultStorage.js'

// ============================================================================
// Phase 4: Real Agent Runtime integration smoke test
//
// Drives the REAL runtime seam functions in the exact order Agent Core uses,
// with a REAL tool (SyntheticOutputTool) doing the tool execution — no mocks,
// no LLM credentials required. The only scripted parts are the assistant API
// responses, which are piped through `normalizeContentFromAPI` exactly as the
// Anthropic client does at anthropicMessages.ts ~2543 before wrapping them in
// codev store messages.
//
// Lifecycle under test:
//   user (store wrapper, inner AgentUserMessage)
//     → normalizeMessagesForAPI (pre-client assembly)
//     → assistant #1 [text + citations + thinking + tool_use]
//         (normalizeContentFromAPI = client's wire→store boundary)
//     → REAL tool execution: SyntheticOutputTool.call()
//         + mapToolResultToToolResultBlockParam (Tool.ts contract)
//         + processPreMappedToolResultBlock (large-result persistence)
//     → tool_result user message (store createUserMessage, sourceToolAssistantUUID)
//     → ensureToolResultPairing (cross-message pairing validation)
//     → assistant #2 continuation [text]
//     → normalizeMessagesForAPI + addCacheBreakpoints (full history → wire)
//
// Verified: text / tool_use / tool_result / thinking blocks, citations
// (providerOptions) never leak as `providerOptions` on the wire, the
// Anthropic-specific wire fields (cache_control marker, cache_reference,
// citations) are owned by the client/adapter layer, and the store wrapper ↔
// inner AgentMessage boundary stays intact.
// ============================================================================

const UUID = 'runtime-smoke-uuid'
const TS = 1700000000000

function wireContent(param: MessageParam): ContentBlockParam[] {
  return Array.isArray(param.content) ? param.content : [param.content]
}

function expectNoProviderOptions(blocks: ContentBlockParam[]): void {
  for (const block of blocks) {
    expect(Object.keys(block)).not.toContain('providerOptions')
  }
}

const CITATIONS = [
  {
    cited_text: 'quoted line',
    document_index: 0,
    document_title: 'doc.txt',
    start_char_index: 0,
    end_char_index: 11,
  },
]

// ============================================================================
// Build the runtime lifecycle once, from the real seam functions
// ============================================================================

async function buildRuntimeLifecycle() {
  // --- 1. User turn: human prompt stored as canonical inner AgentUserMessage
  const userTurn = createStoreUserMessage({
    content: 'List the files in the repo root',
  })
  expect(userTurn.type).toBe('user')
  expect(userTurn.message.role).toBe('user')
  expect(typeof userTurn.message.content).toBe('string')

  // --- 2. Pre-client assembly (what Query does before calling the client)
  const firstPass = normalizeMessagesForAPI([userTurn] as never, [])
  expect(firstPass).toHaveLength(1)
  expect(firstPass[0]!.type).toBe('user')

  // --- 3. Assistant #1: scripted API response → wire→store boundary. This
  //        mirrors the real client assembly: result.content is piped through
  //        normalizeContentFromAPI and wrapped as a store message.
  const rawAPIResponse1 = [
    // Exact Anthropic wire shape the API returns (signature included).
    { type: 'text', text: 'I will list the repo root for you.', citations: CITATIONS },
    { type: 'thinking', thinking: 'Determine the repo layout first', signature: 'sig_1' },
    { type: 'tool_use', id: 'tu_1', name: 'StructuredOutput', input: { format: 'summary', count: 3 } },
  ] as unknown as AgentContentBlock[]
  const normalized1 = normalizeContentFromAPI(rawAPIResponse1, [], undefined)
  // The real client wrapper spreads the API response id onto the inner
  // message (anthropicMessages.ts ~2543). normalizeMessagesForAPI merges
  // consecutive assistants by that inner `id`, so mirror it here.
  const assistant1Inner = {
    ...createAssistantMessage(normalized1, UUID, TS, {
      model: 'test-model',
    }),
    id: `msg_${UUID}_1`,
  }
  const assistant1 = {
    type: 'assistant' as const,
    message: assistant1Inner,
    uuid: UUID,
    timestamp: TS,
    model: 'test-model',
  }

  // Canonical storage boundary: citations live in providerOptions, thinking
  // keeps its signature, tool_use is a canonical AgentToolUseBlock.
  expect(assistant1Inner.content[0]).toEqual({
    type: 'text',
    text: 'I will list the repo root for you.',
    providerOptions: { citations: CITATIONS },
  })
  expect(assistant1Inner.content[1]).toEqual({
    type: 'thinking',
    thinking: 'Determine the repo layout first',
    signature: 'sig_1',
  })
  expect(assistant1Inner.content[2]).toEqual({
    type: 'tool_use',
    id: 'tu_1',
    name: 'StructuredOutput',
    input: { format: 'summary', count: 3 },
  })

  // --- 4. REAL tool execution: call the actual tool, then map its result
  //        through the exact Tool.ts contract runToolUse uses.
  const tool = SyntheticOutputTool
  const toolResult = await tool.call({
    format: 'summary',
    count: 3,
  })
  expect(toolResult.data).toBe('Structured output provided successfully')

  const mappedToolResultBlock = tool.mapToolResultToToolResultBlockParam(
    toolResult.data,
    'tu_1',
  )
  expect(mappedToolResultBlock).toEqual({
    tool_use_id: 'tu_1',
    type: 'tool_result',
    content: 'Structured output provided successfully',
  })

  // Large-result persistence boundary (small results pass through unchanged).
  const processedToolResult = await processPreMappedToolResultBlock(
    mappedToolResultBlock,
    tool.name,
    tool.maxResultSizeChars,
  )
  expect(processedToolResult).toEqual(mappedToolResultBlock)

  // --- 5. tool_result 回流: the store tool-result user message, mirroring
  //        addToolResult in toolExecution.ts (sourceToolAssistantUUID links
  //        the result back to the assistant message that made the tool_use).
  const toolResultUser = createStoreUserMessage({
    content: [processedToolResult as unknown as AgentContentBlock],
    sourceToolAssistantUUID: assistant1.message.uuid,
  })
  expect(toolResultUser.message.content[0]).toEqual({
    type: 'tool_result',
    tool_use_id: 'tu_1',
    content: 'Structured output provided successfully',
  })
  expect(toolResultUser.sourceToolAssistantUUID).toBe(UUID)

  // --- 6. Pairing validation: no spurious repair on a well-formed history.
  const history = [userTurn, assistant1, toolResultUser] as never
  const paired = ensureToolResultPairing(history)
  expect(paired).toEqual(history)

  // --- 7. Assistant #2 continuation (ends in a text block so the cache
  //        marker can land on it).
  const rawAPIResponse2 = [
    { type: 'text', text: 'Found 12 entries, including package.json, src/, and docs/.' },
  ] as unknown as AgentContentBlock[]
  const assistant2 = {
    type: 'assistant' as const,
    message: {
      ...createAssistantMessage(
        normalizeContentFromAPI(rawAPIResponse2, [], undefined),
        `${UUID}-2`,
        TS + 1,
        { model: 'test-model' },
      ),
      id: `msg_${UUID}_2`,
    },
    uuid: `${UUID}-2`,
    timestamp: TS + 1,
    model: 'test-model',
  }

  return { userTurn, assistant1, toolResultUser, assistant2 }
}

// ============================================================================
// 1. Full lifecycle → wire payload (caching on): the exact request shape the
//    Anthropic client sends after Query's pre-client assembly.
// ============================================================================

describe('runtime lifecycle: user → assistant → tool_use → tool_result → assistant (wire)', () => {
  test('full history converts to a valid alternating wire payload with cache marker', async () => {
    const { userTurn, assistant1, toolResultUser, assistant2 } =
      await buildRuntimeLifecycle()

    const history = [userTurn, assistant1, toolResultUser, assistant2] as never
    const normalized = normalizeMessagesForAPI(history, [])
    const params = addCacheBreakpoints(
      normalized,
      true, // enablePromptCaching
      undefined,
      false,
      null,
      [],
      false,
    )

    expect(params).toHaveLength(4)
    expect(params.map(p => p.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])

    // param 0: user text — non-cache path passes a string content through
    // as a bare string (the SDK accepts it), no marker (not the last message)
    expect(params[0]!.content).toBe('List the files in the repo root')
    expect(params[0]!.content).not.toHaveProperty('providerOptions')

    // param 1: assistant #1 — citations restored from providerOptions (adapter
    // owns the citation field), no providerOptions leak, thinking signature
    // intact, tool_use preserved with id/name/input.
    const a1 = wireContent(params[1]!)
    expect(a1[0]).toEqual({
      type: 'text',
      text: 'I will list the repo root for you.',
      citations: CITATIONS,
    })
    expect(a1[1]).toEqual({
      type: 'thinking',
      thinking: 'Determine the repo layout first',
      signature: 'sig_1',
    })
    expect(a1[2]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'StructuredOutput',
      input: { format: 'summary', count: 3 },
    })
    expectNoProviderOptions(a1)

    // param 2: tool_result user message — paired by tool_use_id. On the
    // standard path (useCachedMC=false) the client does NOT add cache_reference
    // (that's a cache-editing feature — see the cache-editing test below).
    // providerOptions never leaks here either.
    const a2 = wireContent(params[2]!)
    expect(a2).toHaveLength(1)
    expect(a2[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'Structured output provided successfully',
    })
    expect(a2[0]).not.toHaveProperty('cache_reference')
    expectNoProviderOptions(a2)

    // param 3: assistant continuation — exactly one cache_control marker on
    // its (compatible) last block.
    const a3 = wireContent(params[3]!)
    expect(a3).toEqual([
      {
        type: 'text',
        text: 'Found 12 entries, including package.json, src/, and docs/.',
        cache_control: { type: 'ephemeral' },
      },
    ])
    expectNoProviderOptions(a3)
  })

  test('cache-editing path (useCachedMC) adds cache_reference to tool_result blocks', async () => {
    const { userTurn, assistant1, toolResultUser, assistant2 } =
      await buildRuntimeLifecycle()
    const history = [userTurn, assistant1, toolResultUser, assistant2] as never
    const normalized = normalizeMessagesForAPI(history, [])
    const params = addCacheBreakpoints(
      normalized,
      true, // enablePromptCaching
      undefined,
      true, // useCachedMC — resolves to the cache-editing branch
      null,
      [],
      false,
    )

    // tool_result user message sits strictly before the marker → the client
    // stamps cache_reference from the tool_use_id (mycro/mycloud contract).
    const a2 = wireContent(params[2]!)
    expect(a2[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'Structured output provided successfully',
      cache_reference: 'tu_1',
    })
    expectNoProviderOptions(a2)
    // Marker still lands on the last assistant's text block.
    expect(wireContent(params[3]!)[0]).toEqual({
      type: 'text',
      text: 'Found 12 entries, including package.json, src/, and docs/.',
      cache_control: { type: 'ephemeral' },
    })
  })
})

// ============================================================================
// 2. Wire conversion standalone (caching off): adapter-owned fields only.
// ============================================================================

describe('runtime lifecycle: wire conversion without caching', () => {
  test('assistant converts with citations restored but no cache fields', async () => {
    const { assistant1 } = await buildRuntimeLifecycle()
    const param = assistantMessageToMessageParam(
      assistant1 as never,
      false,
      false,
    )
    const content = wireContent(param)
    expect(content).toEqual([
      {
        type: 'text',
        text: 'I will list the repo root for you.',
        citations: CITATIONS,
      },
      {
        type: 'thinking',
        thinking: 'Determine the repo layout first',
        signature: 'sig_1',
      },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'StructuredOutput',
        input: { format: 'summary', count: 3 },
      },
    ])
    expectNoProviderOptions(content)
    expect(content[0]).not.toHaveProperty('cache_control')
    expect(content[1]).not.toHaveProperty('cache_control')
    expect(content[2]).not.toHaveProperty('cache_control')
  })

  test('tool_result user message converts with tool_use_id only', async () => {
    const { toolResultUser } = await buildRuntimeLifecycle()
    const param = userMessageToMessageParam(toolResultUser as never, false, false)
    expect(wireContent(param)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'Structured output provided successfully',
      },
    ])
  })
})

// ============================================================================
// 4. Escape-hatch blocks through the runtime pipeline
// ============================================================================

describe('runtime lifecycle: escape-hatch blocks', () => {
  test('server_tool_use + paired *_tool_result survive wire→store→wire verbatim, no providerOptions leak', async () => {
    // Raw API wire shapes for unknown (beta/partner) block types. The Agent
    // Core must not canonicalize them — only normalize the stringified input.
    const raw = [
      { type: 'server_tool_use', id: 'srv_1', name: 'mcp_tool', input: '{"a":1}' },
      { type: 'advisor_tool_result', tool_use_id: 'srv_1', content: 'mcp ok' },
    ] as unknown as AgentContentBlock[]
    const normalized = normalizeContentFromAPI(raw, [], undefined)
    expect(normalized).toEqual([
      { type: 'server_tool_use', id: 'srv_1', name: 'mcp_tool', input: { a: 1 } },
      { type: 'advisor_tool_result', tool_use_id: 'srv_1', content: 'mcp ok' },
    ])

    const escapeAssistant = {
      type: 'assistant' as const,
      message: {
        ...createAssistantMessage(normalized, `${UUID}-eh`, TS + 2),
        id: `msg_${UUID}_eh`,
      },
      uuid: `${UUID}-eh`,
      timestamp: TS + 2,
    }

    // Pairing must not strip the escape-hatch blocks: the use block has its
    // result id present in the same assistant message.
    expect(ensureToolResultPairing([escapeAssistant] as never)).toEqual([
      escapeAssistant,
    ])

    // Pre-client assembly only canonicalizes `tool_use` blocks — unknown
    // block types pass through untouched.
    const assembled = normalizeMessagesForAPI([escapeAssistant] as never, [])
    expect(assembled).toHaveLength(1)

    // Wire conversion passes escape-hatch blocks through verbatim and never
    // injects providerOptions.
    const param = assistantMessageToMessageParam(assembled[0] as never, false, false)
    expect(wireContent(param)).toEqual([
      { type: 'server_tool_use', id: 'srv_1', name: 'mcp_tool', input: { a: 1 } },
      { type: 'advisor_tool_result', tool_use_id: 'srv_1', content: 'mcp ok' },
    ])
    expectNoProviderOptions(wireContent(param))
  })
})

// ============================================================================
// 3. Store wrapper ↔ inner AgentMessage boundary
// ============================================================================

describe('runtime lifecycle: store wrapper ↔ canonical inner message boundary', () => {
  test('stored user message inner content is the canonical AgentUserMessage', async () => {
    const { userTurn } = await buildRuntimeLifecycle()
    // The store inner message IS the canonical semantic message — role +
    // content carry the provider-agnostic shape the wire builders consume.
    // uuid/timestamp are carried by the outer store wrapper, not the inner.
    expect(userTurn.message.role).toBe('user')
    expect(userTurn.message.content).toBe('List the files in the repo root')
    expect(userTurn.uuid).toBeTypeOf('string')
    expect(userTurn.timestamp).toBeTypeOf('string')
  })

  test('canonical createAssistantMessage output flows through the whole pipeline', async () => {
    const { assistant1, toolResultUser, assistant2 } =
      await buildRuntimeLifecycle()
    // Build a fresh assistant from the canonical factory only, then run the
    // full pre-client assembly → wire conversion on a 4-message history.
    const fresh = {
      type: 'assistant' as const,
      message: {
        ...createAssistantMessage(
          [
            createTextBlock('checking'),
            createThinkingBlock('hmm', 'sig_9'),
            createToolUseBlock('tu_9', 'StructuredOutput', { format: 'x' }),
          ],
          `${UUID}-9`,
          TS + 9,
        ),
        id: `msg_${UUID}_9`,
      },
      uuid: `${UUID}-9`,
      timestamp: TS + 9,
    }
    const history = [
      assistant1,
      toolResultUser,
      assistant2,
      fresh,
    ] as never
    const params = addCacheBreakpoints(
      normalizeMessagesForAPI(history, []),
      true,
      undefined,
      false,
      null,
      [],
      false,
    )
    const last = wireContent(params[3]!)
    expect(last).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'thinking', thinking: 'hmm', signature: 'sig_9' },
      {
        type: 'tool_use',
        id: 'tu_9',
        name: 'StructuredOutput',
        input: { format: 'x' },
        cache_control: { type: 'ephemeral' },
      },
    ])
    expectNoProviderOptions(last)
  })

  test('pairing validation is a no-op on the well-formed lifecycle history', async () => {
    const { userTurn, assistant1, toolResultUser, assistant2 } =
      await buildRuntimeLifecycle()
    const history = [userTurn, assistant1, toolResultUser, assistant2] as never
    // ensureToolResultPairing must not synthesize error tool_results or strip
    // anything on an already-paired transcript (migration did not break
    // pairing).
    expect(ensureToolResultPairing(history)).toEqual(history)
  })
})