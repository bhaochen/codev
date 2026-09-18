import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import type { Options } from '../clients/anthropicMessages.js'
import { assembleAnthropicOptions } from '../clients/anthropicMessages.js'
import { toLLMRequest } from '../../api/queryModel.js'
import type { ThinkingConfig } from '../../../utils/thinking.js'

// ============================================================================
// LLM service-layer ownership tests
//
// Verifies the Phase 9 ownership cleanup:
//   1. runtime/ and protocols/* no longer import Anthropic Options / SDK
//      message types (except the Anthropic protocol implementation itself).
//   2. ModelRuntime no longer smuggles thinkingConfig into Options via a cast.
//   3. The provider-neutral types carry no Anthropic SDK types.
//   4. toLLMRequest (facade) → assembleAnthropicOptions (Anthropic boundary)
//      round-trips every Options field, so provider behavior is unchanged.
// ============================================================================

function sampleOptions(): Options {
  return {
    getToolPermissionContext: async () => ({}) as never,
    model: 'claude-sonnet-4-6',
    isNonInteractiveSession: true,
    querySource: 'main',
    agents: [],
    mcpTools: [] as never,
    hasAppendSystemPrompt: true,
    toolChoice: { type: 'tool', name: 'bash' },
    maxOutputTokensOverride: 8192,
    temperatureOverride: 0.3,
    enablePromptCaching: true,
    skipCacheWrite: false,
    outputFormat: { type: 'json_object' } as never,
    extraToolSchemas: [
      { type: 'custom', name: 'x', input_schema: { type: 'object' } },
    ] as never,
    effortValue: 5,
    taskBudget: { total: 100, remaining: 40 },
    fallbackModel: 'claude-haiku-4-5',
    onStreamingFallback: () => {},
    queryTracking: { queryId: 'q1' } as never,
    agentId: 'agent-1' as never,
    fastMode: true,
    hasPendingMcpServers: false,
    addNotification: () => {},
    specStore: {} as never,
    specBudget: {} as never,
  }
}

function buildRequest(options: Options, thinkingConfig: ThinkingConfig) {
  return toLLMRequest({
    model: options.model,
    messages: [] as never,
    systemPrompt: [] as never,
    thinkingConfig,
    tools: [] as never,
    signal: new AbortController().signal,
    options,
  })
}

describe('LLM service layer: runtime boundary is provider-neutral', () => {
  const audited = [
    'src/services/llm/runtime/types.ts',
    'src/services/llm/runtime/ModelRuntime.ts',
    'src/services/llm/runtime/index.ts',
    'src/services/llm/clients/index.ts',
    'src/services/llm/clients/openaiChat.ts',
    'src/services/llm/protocols/index.ts',
    'src/services/llm/protocols/openaiResponses.ts',
    'src/services/llm/protocols/openaiCompatibleChat.ts',
  ]

  test('runtime/ & protocols/* (non-Anthropic files) do not import Anthropic Options / message types', () => {
    for (const file of audited) {
      const s = readFileSync(file, 'utf8')
      // No Options *type* import from the Anthropic protocol client, no Anthropic
      // SDK message/param types. (Registry value-wiring `queryAnthropicMessages`
      // in protocols/index.ts is the single source of truth — a handler value,
      // not an Options/message type import; APIUserAbortError-from-sdk remains
      // fine — it is not a message type; see audit list.)
      expect(s).not.toContain('import type { Options }')
      expect(s).not.toContain('BetaMessageParam')
      expect(s).not.toContain('BetaToolChoice')
      expect(s).not.toContain('BetaJSONOutputFormat')
    }
  })

  test('the only anthropicMessages import outside its own file is the registry handler wiring', () => {
    // protocols/index.ts registers the Anthropic implementation by value — the
    // wiring is required for the single source of truth, but must never pull in
    // the Options bundle or message types.
    const registry = readFileSync('src/services/llm/protocols/index.ts', 'utf8')
    expect(registry).toContain("import { queryAnthropicMessages } from '../clients/anthropicMessages.js'")
    // The registry may import neutral types (LLMRoute, LLMRequest etc.) but must
    // never pull Options, BetaMessageParam, or other Anthropic SDK types.
    expect(registry).not.toContain('import type { Options }')
    expect(registry).not.toContain('BetaMessageParam')
  })

  test('the provider-neutral service types (runtime/types.ts) carry no Anthropic SDK import', () => {
    const s = readFileSync('src/services/llm/runtime/types.ts', 'utf8')
    expect(s).not.toContain("@anthropic-ai/sdk")
  })

  test('ModelRuntime no longer casts thinkingConfig into Options', () => {
    const s = readFileSync('src/services/llm/runtime/ModelRuntime.ts', 'utf8')
    expect(s).not.toContain('as unknown as')
    expect(s).toContain('LLMRequest')
  })

  test('LLMClient / ProtocolHandler boundaries are typed by the neutral LLMRequest', () => {
    for (const file of [
      'src/services/llm/clients/index.ts',
      'src/services/llm/protocols/index.ts',
    ]) {
      const s = readFileSync(file, 'utf8')
      expect(s).toContain('LLMRequest')
      expect(s).not.toContain('Options')
    }
  })
})

describe('LLM service layer: Options → LLMRequest → Options round-trip', () => {
  test('every Options field survives the boundary byte-for-byte', () => {
    const options = sampleOptions()
    const thinkingConfig: ThinkingConfig = { type: 'enabled', budgetTokens: 1024 }
    const request = buildRequest(options, thinkingConfig)
    // The neutral config carries the model-call params; the context carries the
    // codev runtime plumbing. Both stay provider-neutral by construction.
    expect(request.config.maxOutputTokens).toBe(8192)
    expect(request.config.temperature).toBe(0.3)
    expect(request.config.thinking).toEqual({ type: 'enabled', budgetTokens: 1024 })
    expect(request.context.agents).toBe(options.agents)

    const rebuilt = assembleAnthropicOptions(request)
    // thinkingConfig is the one field that crosses via a separate arg (not via
    // Options) so it's the only key present on rebuilt but absent on the
    // caller-provided Options.  Compare everything else for key+value equality.
    const { thinkingConfig: _tc, ...rebuiltCore } = rebuilt as { thinkingConfig?: ThinkingConfig } & Omit<Options, 'thinkingConfig'>
    expect(rebuiltCore).toEqual(options)
    expect(_tc).toEqual({ type: 'enabled', budgetTokens: 1024 })
  })

  test('undefined cache intent stays undefined (no default invented at the boundary)', () => {
    const options = sampleOptions()
    delete (options as Partial<Options>).enablePromptCaching
    delete (options as Partial<Options>).skipCacheWrite
    const rebuilt = assembleAnthropicOptions(
      buildRequest(options, { type: 'disabled' }),
    )
    expect('enablePromptCaching' in rebuilt).toBe(false)
    expect('skipCacheWrite' in rebuilt).toBe(false)
    const { thinkingConfig: _tc, ...rest } = rebuilt as { thinkingConfig?: ThinkingConfig } & Omit<Options, 'thinkingConfig'>
    expect(rest).toEqual(options)
  })

  test('missing thinking falls back to disabled at the Anthropic boundary', () => {
    const options = sampleOptions()
    const request = toLLMRequest({
      model: options.model,
      messages: [] as never,
      systemPrompt: [] as never,
      thinkingConfig: undefined as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options,
    })
    delete (request.config as { thinking?: unknown }).thinking
    const rebuilt = assembleAnthropicOptions(request)
    expect(
      (rebuilt as unknown as { thinkingConfig?: ThinkingConfig }).thinkingConfig,
    ).toEqual({ type: 'disabled' })
    // Core Options fields still match the original caller options
    const { thinkingConfig: _tc, ...rest } = rebuilt as { thinkingConfig?: ThinkingConfig } & Omit<Options, 'thinkingConfig'>
    expect(rest).toEqual(options)
  })

  test('anthropic-boundary-only fields travel through providerOptions and come back intact', () => {
    const options = sampleOptions()
    const rebuilt = assembleAnthropicOptions(
      buildRequest(options, { type: 'disabled' }),
    )
    // extraToolSchemas rides providerOptions (no neutral home); identity kept.
    expect(rebuilt.extraToolSchemas).toBe(options.extraToolSchemas)
  })
})