import type Anthropic from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages.js'
import {
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
} from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../constants/system.js'
import { logEvent } from '../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/metadata.js'
import { getAPIMetadata } from '../services/llm/utils/metadata.js'
import { getModelBetas, modelSupportsStructuredOutputs } from './betas.js'
import { computeFingerprint } from './fingerprint.js'
import { normalizeModelStringForAPI } from './model/model.js'
import { modelRuntime } from '../services/llm/runtime/index.js'
import type { LLMRequest, LLMRequestConfig, LLMRuntimeContext, LLMResponseFormat, LLMToolChoice } from '../services/llm/runtime/types.js'
import type { Message, StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../types/message.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import type { Tools } from '../Tool.js'
import type { ThinkingConfig } from '../utils/thinking.js'

/** Query source identifiers for analytics/telemetry. */
type QuerySource =
  | 'permission_explainer'
  | 'session_search'
  | 'model_validation'
  | 'chrome_mcp'
  | 'auto_mode'
  | 'memdir_relevance'
  | 'auto_mode_critique'
  | string

type MessageParam = Anthropic.MessageParam
type TextBlockParam = Anthropic.TextBlockParam
type Tool = Anthropic.Tool
type ToolChoice = Anthropic.ToolChoice
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaJSONOutputFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat
type BetaThinkingConfigParam = Anthropic.Beta.Messages.BetaThinkingConfigParam
type BetaStopReason = Anthropic.Beta.Messages.BetaStopReason

export type SideQueryOptions = {
  /** Model to use for the query */
  model: string
  /**
   * System prompt - string or array of text blocks (will be prefixed with CLI attribution).
   *
   * The attribution header is always placed in its own TextBlockParam block to ensure
   * server-side parsing correctly extracts the cc_entrypoint value without including
   * system prompt content.
   */
  system?: string | TextBlockParam[]
  /** Messages to send (supports cache_control on content blocks) */
  messages: MessageParam[]
  /** Optional tools (supports both standard Tool[] and BetaToolUnion[] for custom tool types) */
  tools?: Tool[] | BetaToolUnion[]
  /** Optional tool choice (use { type: 'tool', name: 'x' } for forced output) */
  tool_choice?: ToolChoice
  /** Optional JSON output format for structured responses */
  output_format?: BetaJSONOutputFormat
  /** Max tokens (default: 1024) */
  max_tokens?: number
  /** Max retries (default: 2) */
  maxRetries?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Skip CLI system prompt prefix (keeps attribution header for OAuth). For internal classifiers that provide their own prompt. */
  skipSystemPromptPrefix?: boolean
  /** Temperature override */
  temperature?: number
  /** Thinking budget (enables thinking), or `false` to send `{ type: 'disabled' }`. */
  thinking?: number | false
  /** Stop sequences — generation stops when any of these strings is emitted */
  stop_sequences?: string[]
  /** Attributes this call in tengu_api_success for COGS joining against reporting.sampling_calls. */
  querySource: QuerySource
}

/**
 * Extract text from first user message for fingerprint computation.
 */
function extractFirstUserMessageText(messages: MessageParam[]): string {
  const firstUserMessage = messages.find(m => m.role === 'user')
  if (!firstUserMessage) return ''

  const content = firstUserMessage.content
  if (typeof content === 'string') return content

  // Array of content blocks - find first text block
  const textBlock = content.find(block => block.type === 'text')
  return textBlock?.type === 'text' ? textBlock.text : ''
}

/**
 * Convert Anthropic MessageParam to Agent semantic Message.
 */
function convertMessageParam(msg: MessageParam): Message {
  if (msg.role === 'user') {
    const content = msg.content
    let blocks: Message['content'] = []
    if (typeof content === 'string') {
      blocks = [{ type: 'text', text: content }]
    } else {
      blocks = content.map(block => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        }
        if (block.type === 'image') {
          return {
            type: 'image',
            source: block.source.type === 'base64'
              ? { type: 'base64', media_type: block.source.media_type, data: block.source.data }
              : { type: 'url', url: block.source.url },
          }
        }
        if (block.type === 'tool_use') {
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        }
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          }
        }
        if (block.type === 'thinking') {
          return { type: 'thinking', thinking: block.thinking, signature: block.signature }
        }
        if (block.type === 'redacted_thinking') {
          return { type: 'redacted_thinking', data: block.data }
        }
        // Pass through unknown blocks
        return block as any
      })
    }
    return { role: 'user', content: blocks, uuid: crypto.randomUUID(), timestamp: Date.now() }
  } else {
    const content = msg.content
    let blocks: Message['content'] = []
    if (typeof content === 'string') {
      blocks = [{ type: 'text', text: content }]
    } else {
      blocks = content.map(block => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        }
        if (block.type === 'tool_use') {
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        }
        if (block.type === 'thinking') {
          return { type: 'thinking', thinking: block.thinking, signature: block.signature }
        }
        if (block.type === 'redacted_thinking') {
          return { type: 'redacted_thinking', data: block.data }
        }
        return block as any
      })
    }
    return { role: 'assistant', content: blocks, uuid: crypto.randomUUID(), timestamp: Date.now() }
  }
}

/**
 * Convert system prompt to SystemPrompt (readonly string[]).
 */
function convertSystemPrompt(
  system: string | TextBlockParam[] | undefined,
  attributionHeader: string | undefined,
  skipSystemPromptPrefix: boolean | undefined,
): SystemPrompt {
  const parts: string[] = []

  if (attributionHeader) {
    parts.push(attributionHeader)
  }

  if (!skipSystemPromptPrefix) {
    parts.push(
      getCLISyspromptPrefix({
        isNonInteractive: false,
        hasAppendSystemPrompt: false,
      }),
    )
  }

  if (system) {
    if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text') {
          parts.push(block.text)
        }
      }
    } else {
      parts.push(system)
    }
  }

  return asSystemPrompt(parts)
}

/**
 * Convert Anthropic Tool/BetaToolUnion to minimal Agent Tool for schema-only use.
 * Side queries don't execute tools; they only need schemas for the model.
 */
function convertTools(tools?: Tool[] | BetaToolUnion[]): Tools {
  if (!tools) return [] as Tools
  return tools.map(t => {
    const schema = t.input_schema as Record<string, unknown>
    return {
      name: t.name,
      input_schema: schema,
      // Minimal stubs for required Tool fields - side queries don't execute tools
      aliases: undefined,
      searchHint: undefined,
      call: async () => ({ content: [], isError: false, data: undefined }),
      description: () => t.description ?? '',
      render: () => null,
    }
  }) as unknown as Tools
}

/**
 * Convert Anthropic ToolChoice to LLMToolChoice.
 */
function convertToolChoice(choice?: ToolChoice): LLMToolChoice | undefined {
  if (!choice) return undefined
  if (choice.type === 'auto') return { type: 'auto' }
  if (choice.type === 'any') return { type: 'any' }
  if (choice.type === 'tool') return { type: 'tool', name: choice.name }
  return undefined
}

/**
 * Convert output_format to LLMResponseFormat.
 * BetaJSONOutputFormat only has 'json_schema' type.
 */
function convertOutputFormat(format?: BetaJSONOutputFormat): LLMResponseFormat | undefined {
  if (!format) return undefined
  // BetaJSONOutputFormat only has type: 'json_schema'
  if (format.type === 'json_schema') {
    return { type: 'json_schema', name: 'structured_output', schema: format.schema }
  }
  return undefined
}

/**
 * Convert thinking config to ThinkingConfig.
 */
function convertThinking(thinking?: number | false): ThinkingConfig | undefined {
  if (thinking === false) return { type: 'disabled' }
  if (thinking !== undefined) return { type: 'enabled', budgetTokens: thinking }
  return undefined
}

/**
 * Lightweight API wrapper for "side queries" outside the main conversation loop.
 *
 * Uses the new LLM runtime (ModelRuntime) instead of the legacy Anthropic SDK client.
 *
 * This handles:
 * - Fingerprint computation for OAuth validation
 * - Attribution header injection
 * - CLI system prompt prefix
 * - Proper betas for the model
 * - API metadata
 * - Model string normalization (strips [1m] suffix for API)
 *
 * @example
 * // Permission explainer
 * await sideQuery({ querySource: 'permission_explainer', model, system: SYSTEM_PROMPT, messages, tools, tool_choice })
 *
 * @example
 * // Session search
 * await sideQuery({ querySource: 'session_search', model, system: SEARCH_PROMPT, messages })
 *
 * @example
 * // Model validation
 * await sideQuery({ querySource: 'model_validation', model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  // Extract first user message text for fingerprint
  const messageText = extractFirstUserMessageText(messages)

  // Compute fingerprint for OAuth attribution
  const fingerprint = computeFingerprint(messageText, MACRO.VERSION)
  const attributionHeader = getAttributionHeader(fingerprint)

  // Build system prompt
  const systemPrompt = convertSystemPrompt(system, attributionHeader, skipSystemPromptPrefix)

  // Convert messages
  const agentMessages = messages.map(convertMessageParam)

  // Convert tools
  const agentTools = convertTools(tools)

  // Convert tool choice
  const toolChoice = convertToolChoice(tool_choice)

  // Convert output format
  const responseFormat = convertOutputFormat(output_format)

  // Convert thinking config
  const thinkingConfig = convertThinking(thinking)

  // Build betas
  const betas = [...getModelBetas(model)]
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // Build config
  const config: LLMRequestConfig = {
    maxOutputTokens: max_tokens,
    temperature,
    stopSequences: stop_sequences,
    thinking: thinkingConfig,
    toolChoice,
    responseFormat,
    providerOptions: betas.length > 0 ? { betas } : undefined,
  }

  // Build context
  const context: LLMRuntimeContext = {
    model,
    getToolPermissionContext: () => Promise.resolve({} as any),
    agents: [],
    allowedAgentTypes: undefined,
    fetchOverride: undefined,
    agentId: undefined,
    isNonInteractiveSession: false,
    querySource: opts.querySource,
    hasAppendSystemPrompt: false,
    addNotification: undefined,
    effortValue: undefined,
    fallbackModel: undefined,
    onStreamingFallback: undefined,
    mcpTools: [],
    hasPendingMcpServers: undefined,
    queryTracking: undefined,
    fastMode: false,
    advisorModel: undefined,
    specStore: undefined,
    specBudget: undefined,
  }

  // Build LLMRequest
  const request: LLMRequest = {
    model: normalizeModelStringForAPI(model),
    messages: agentMessages,
    systemPrompt,
    tools: agentTools,
    signal: signal ?? new AbortSignal(),
    config,
    context,
  }

  const start = Date.now()
  let assistantMessage: AssistantMessage | undefined

  // Use the new LLM runtime
  for await (const event of modelRuntime.generate(request)) {
    // modelRuntime.generate yields LLMStreamEvent | AssistantMessage | SystemAPIErrorMessage
    // AssistantMessage has role: 'assistant' and content array
    if (event && typeof event === 'object' && 'role' in event && (event as any).role === 'assistant') {
      assistantMessage = event as AssistantMessage
    }
  }

  if (!assistantMessage) {
    if (signal?.aborted) {
      throw new Error('Request aborted')
    }
    throw new Error('No assistant message found')
  }

  // Build BetaMessage-compatible response
  const normalizedModel = normalizeModelStringForAPI(model)
  const response: BetaMessage = {
    id: assistantMessage.uuid ?? crypto.randomUUID(),
    type: 'message',
    role: 'assistant',
    content: assistantMessage.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
      if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking, signature: block.signature }
      if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data }
      return block as any
    }),
    model: normalizedModel,
    stop_reason: (assistantMessage.stop_reason ?? 'end_turn') as BetaStopReason,
    stop_sequence: null,
    container: null,
    usage: {
      input_tokens: assistantMessage.usage?.input_tokens ?? 0,
      output_tokens: assistantMessage.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: assistantMessage.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: assistantMessage.usage?.cache_read_input_tokens ?? 0,
      cache_creation: null,
      inference_geo: null,
    } as any,
    context_management: null,
  }

  const requestId = (response as { _request_id?: string | null })._request_id ?? undefined
  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('tengu_api_success', {
    requestId:
      requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      normalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  return response
}