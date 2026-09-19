/**
 * OpenAI Chat Completions wire — native request/response implementation.
 *
 * This module owns the entire OpenAI Chat wire boundary for the LLM service
 * layer: request-body assembly, Agent → Chat message conversion, tool schema
 * sanitization, and Chat-format SSE → LLMStreamEvent adaptation. It imports
 * NO provider SDK conversion helpers, matching the native-adapter design used
 * elsewhere in protocols/.
 *
 * Lineage: behavior is replicated 1:1 from the legacy Anthropic→OpenAI
 * conversion pipeline, minus the Anthropic-shaped intermediate representation:
 *   - thinking blocks map via `reasoning_content`-family deltas into Agent
 *     thinking blocks WITHOUT a fake Anthropic `signature` (DeepSeek round-trip
 *     only cares about reasoning_content being echoed back).
 *   - stop_reason is derived natively from `finish_reason` (never invented).
 *   - usage maps prompt_tokens/cached_tokens/completion_tokens → the Agent
 *     runtime's four-field shape; completion_tokens (which OpenAI includes
 *     reasoning tokens in) → output_tokens is the correct runtime contract
 *     mapping.
 */

import type { LLMRequestConfig, LLMRuntimeContext } from '../runtime/types.js'
import type {
  AgentContentBlock,
  AgentImageBlock,
} from '../../../types/agentMessage.js'
import type {
  AssistantMessage,
  UserMessage,
} from '../../../types/message.js'
import { isEnvTruthy, isEnvDefinedFalsy } from '../../../utils/envUtils.js'

// ============================================================================
// Wire types
// ============================================================================

export type OpenAIChatToolChoice =
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } }

export type OpenAIChatTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export type OpenAIChatToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type OpenAIChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | OpenAIChatMessagePart[]
  reasoning_content?: string
  tool_calls?: OpenAIChatToolCall[]
  tool_call_id?: string
}

export type OpenAIChatRequestBody = Record<string, unknown> & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
  prompt_cache_key?: string
  reasoning_effort?: 'low' | 'medium' | 'high'
}

/** OpenAI stream chunk as consumed by the Chat adapter. */
export type OpenAIChatWireChunk = Record<string, unknown> & {
  id?: string
  model?: string
  choices?: Array<{
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      reasoning_text?: string | null
      reasoning_details?: Array<{ text?: string }> | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
    index?: number
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
    }
  }
}

/** Provider-neutral normalized usage (runtime contract four fields). */
export type OpenAIChatNormalizedUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/**
 * Chat-native stream events — identical event grammar to the legacy adapter
 * (so consumers code against one contract) but with no Anthropic SDK types.
 */
export type OpenAIChatStreamEvent =
  | {
      type: 'message_start'
      message: {
        id: string
        type: 'message'
        role: 'assistant'
        content: []
        model: string
        stop_reason: null
        stop_sequence: null
        usage: OpenAIChatNormalizedUsage
      }
    }
  | {
      type: 'content_block_start'
      index: number
      content_block:
        | { type: 'text'; text: string }
        | { type: 'thinking'; thinking: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: { stop_reason: string; stop_sequence: null }
      usage: OpenAIChatNormalizedUsage
    }
  | { type: 'message_stop' }

export type OpenAIChatToolSchema = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

// ============================================================================
// URL helper
// ============================================================================

export function chatCompletionsUrlFromBase(base: string): string {
  const b = base.replace(/\/$/, '')
  if (b.endsWith('/v1')) return `${b}/chat/completions`
  return `${b}/v1/chat/completions`
}

// ============================================================================
// Reasoning config → native Chat thinking fields
// ============================================================================

const OPENAI_REASONING_EFFORT: Record<string, 'low' | 'medium' | 'high'> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

/**
 * Detect if this model should run in thinking mode for OpenAI Chat.
 * Mirrors isOpenAIThinkingEnabled (env override > model-name detection),
 * excluding Grok deliberately (Grok reasons automatically).
 */
export function isOpenAIChatThinkingEnabled(model: string): boolean {
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return false
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return true
  const modelLower = model.toLowerCase()
  return (
    modelLower.includes('deepseek') ||
    modelLower.includes('mimo') ||
    modelLower.includes('gpt-oss')
  )
}

/**
 * LLMRequestConfig.thinking / context.effortValue → Chat thinking + effort.
 * The neutral config is the single reasoning source: `disabled` forces off,
 * `enabled` forces on; otherwise the model/env detection governs. reasoning_effort
 * is only emitted alongside thinking (never injected onto non-thinking providers).
 */
export function resolveOpenAIChatThinking(
  model: string,
  config: LLMRequestConfig,
  context: LLMRuntimeContext,
): { enableThinking: boolean; reasoning_effort?: 'low' | 'medium' | 'high' } {
  if (config.thinking?.type === 'disabled') {
    return { enableThinking: false }
  }
  const enableThinking =
    config.thinking?.type === 'enabled' || isOpenAIChatThinkingEnabled(model)
  if (enableThinking && typeof context.effortValue === 'string') {
    const effort = OPENAI_REASONING_EFFORT[context.effortValue]
    if (effort) return { enableThinking, reasoning_effort: effort }
  }
  return { enableThinking }
}

// ============================================================================
// Chat request body
// ============================================================================

/**
 * Assemble the chat.completions request body. Thinking injection uses the
 * three-format fan-out (official DeepSeek / self-hosted DeepSeek / MiMo);
 * unknown keys are passed through by HTTP layers, so coexistence is safe.
 */
export function buildOpenAIChatBody(params: {
  model: string
  messages: OpenAIChatMessage[]
  tools?: OpenAIChatTool[]
  toolChoice?: OpenAIChatToolChoice
  enableThinking: boolean
  maxTokens: number
  temperatureOverride?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** OpenAI 官方端点的会话级 prompt-cache 路由键。 */
  promptCacheKey?: string
}): OpenAIChatRequestBody {
  const {
    model,
    messages,
    tools,
    toolChoice,
    enableThinking,
    maxTokens,
    temperatureOverride,
    reasoningEffort,
    promptCacheKey,
  } = params
  return {
    model,
    messages,
    max_tokens: maxTokens,
    ...(promptCacheKey && { prompt_cache_key: promptCacheKey }),
    ...(tools && tools.length > 0 && {
      tools,
      ...(toolChoice && { tool_choice: toolChoice }),
    }),
    stream: true,
    stream_options: { include_usage: true },
    // DeepSeek / MiMo reasoning output; each endpoint recognizes its own format
    ...(enableThinking && {
      thinking: { type: 'enabled' },
      enable_thinking: true,
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }),
    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
    // temperature only when thinking is off (thinking endpoints ignore it)
    ...(!enableThinking &&
      temperatureOverride !== undefined && {
        temperature: temperatureOverride,
      }),
  }
}

// ============================================================================
// Tool schema sanitization + conversion
// ============================================================================

/**
 * Recursively clean a JSON Schema for OpenAI-compatible endpoints: `const`
 * becomes a single-element `enum` (Ollama / vLLM / DeepSeek reject `const`).
 */
function sanitizeJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema

  const result = { ...schema }

  if ('const' in result) {
    result.enum = [result.const]
    delete result.const
  }

  const objectKeys = [
    'properties',
    'definitions',
    '$defs',
    'patternProperties',
  ] as const
  for (const key of objectKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object') {
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(
        nested as Record<string, unknown>,
      )) {
        sanitized[k] =
          v && typeof v === 'object'
            ? sanitizeJsonSchema(v as Record<string, unknown>)
            : v
      }
      result[key] = sanitized
    }
  }

  const singleKeys = [
    'items',
    'additionalProperties',
    'not',
    'if',
    'then',
    'else',
    'contains',
    'propertyNames',
  ] as const
  for (const key of singleKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      result[key] = sanitizeJsonSchema(nested as Record<string, unknown>)
    }
  }

  const arrayKeys = ['anyOf', 'oneOf', 'allOf'] as const
  for (const key of arrayKeys) {
    const nested = result[key]
    if (Array.isArray(nested)) {
      result[key] = nested.map(item =>
        item && typeof item === 'object'
          ? sanitizeJsonSchema(item as Record<string, unknown>)
          : item,
      )
    }
  }

  return result
}

export function openAIChatToolsFromSchemas(
  tools: OpenAIChatToolSchema[],
): OpenAIChatTool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: sanitizeJsonSchema(
        tool.input_schema || { type: 'object', properties: {} },
      ),
    },
  }))
}

/**
 * LLMToolChoice → OpenAI tool_choice (auto → "auto", any → "required",
 * tool → { function: { name } }). undefined keeps the provider default.
 */
export function openAIChatToolChoiceFromLLM(
  toolChoice: unknown,
): OpenAIChatToolChoice | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined
  const tc = toolChoice as Record<string, unknown>
  switch (tc.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return { type: 'function', function: { name: tc.name as string } }
    default:
      return undefined
  }
}

// ============================================================================
// Agent normalized messages → OpenAI Chat messages
// ============================================================================

/** OpenAI 要求 user/assistant 交替；历史可能含连续 assistant 回合，需合并。 */
function pushMergedAssistant(
  result: OpenAIChatMessage[],
  msg: OpenAIChatMessage,
): void {
  const last = result[result.length - 1]
  if (last && last.role === 'assistant' && msg.role === 'assistant') {
    const newText = msg.content
    if (typeof newText === 'string' && newText) {
      last.content =
        typeof last.content === 'string' && last.content
          ? `${last.content}\n${newText}`
          : newText
    }
    if (msg.reasoning_content !== undefined) {
      last.reasoning_content =
        last.reasoning_content === undefined
          ? msg.reasoning_content
          : `${last.reasoning_content}\n${msg.reasoning_content}`
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls]
    }
    return
  }
  result.push(msg)
}

function base64ImageUrl(source: {
  type?: string
  media_type?: string
  data?: string
}): string | undefined {
  if (source?.type !== 'base64' || !source.media_type || !source.data) {
    return undefined
  }
  return `data:${source.media_type};base64,${source.data}`
}

/** Anthropic document 块无法直接映射为 OpenAI 格式：文本型 source 提取为 text，其余丢弃。 */
function extractDocumentText(
  doc: { source?: { type?: string; data?: unknown } },
): string | undefined {
  const src = doc?.source
  if (src?.type === 'text' && typeof src.data === 'string') {
    return src.data
  }
  return undefined
}

/**
 * 规范化 tool_result 的 content：纯文本返回字符串；含图片时返回
 * text + image_url 数组（OpenAI 的 tool message 支持数组 content）。
 * supportsImages=false 时丢弃图片，只保留文本。
 */
function normalizeToolResultContent(
  content: unknown,
  supportsImages: boolean,
): string | OpenAIChatMessagePart[] {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const textParts: string[] = []
  const parts: OpenAIChatMessagePart[] = []
  let hasImage = false
  for (const c of content as Array<{
    type?: string
    text?: string
    source?: { type?: string; media_type?: string; data?: string }
  }>) {
    if (c?.type === 'text') {
      textParts.push(c.text ?? '')
      parts.push({ type: 'text', text: c.text ?? '' })
    } else if (c?.type === 'image') {
      const url = base64ImageUrl(c.source ?? {})
      if (url && supportsImages) {
        hasImage = true
        parts.push({ type: 'image_url', image_url: { url } })
      }
    } else if (c?.type === 'document') {
      const text = extractDocumentText(
        c as unknown as { source?: { type?: string; data?: unknown } },
      )
      if (text) {
        textParts.push(text)
        parts.push({ type: 'text', text })
      }
    }
  }
  if (hasImage) {
    return parts
  }
  return textParts.join('\n')
}

type AgentMessageContent = string | AgentContentBlock[] | undefined

function userMessageContentToOpenAIChat(
  content: AgentMessageContent,
  supportsImages: boolean,
): OpenAIChatMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }]
  }
  if (!Array.isArray(content)) {
    return [{ role: 'user', content: '' }]
  }

  const parts: OpenAIChatMessagePart[] = []
  const toolResults: OpenAIChatMessage[] = []

  for (const block of content) {
    if (block.type === 'text') {
      parts.push({
        type: 'text',
        text: String((block as { text: string }).text ?? ''),
      })
    } else if (block.type === 'image') {
      if (!supportsImages) continue
      const url = base64ImageUrl(
        (block as AgentImageBlock).source ?? {},
      )
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } })
      }
    } else if (block.type === 'document') {
      const text = extractDocumentText(
        block as unknown as { source?: { type?: string; data?: unknown } },
      )
      if (text) {
        parts.push({ type: 'text', text })
      }
    } else if (block.type === 'tool_result') {
      const tr = block as { content?: unknown; tool_use_id: string }
      toolResults.push({
        role: 'tool',
        content: normalizeToolResultContent(tr.content, supportsImages),
        tool_call_id: tr.tool_use_id,
      })
    }
  }

  // CRITICAL: tool 消息必须先于 user 消息。OpenAI 要求 tool 消息紧跟带
  // tool_calls 的 assistant 消息，先发 user 消息会 400。
  if (toolResults.length > 0) {
    toolResults.push({
      role: 'user',
      content:
        parts.length === 1 && parts[0].type === 'text'
          ? parts[0].text!
          : parts.length > 0
            ? parts
            : '',
    })
    return toolResults
  }

  if (parts.length === 0) {
    // 空 content：保留占位，防止消息被静默丢弃破坏后续配对
    return [{ role: 'user', content: '' }]
  }
  if (parts.length === 1 && parts[0].type === 'text') {
    return [{ role: 'user', content: parts[0].text! }]
  }
  return [{ role: 'user', content: parts }]
}

function assistantMessageContentToOpenAIChat(
  content: AgentMessageContent,
): OpenAIChatMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'assistant', content }]
  }
  if (!Array.isArray(content)) {
    return [{ role: 'assistant', content: '' }]
  }

  const textParts: string[] = []
  const toolCalls: OpenAIChatToolCall[] = []
  let reasoningContent: string | undefined

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push((block as { text: string }).text ?? '')
    } else if (block.type === 'tool_use') {
      const tu = block as {
        id: string
        name: string
        input: string | Record<string, unknown>
      }
      toolCalls.push({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments:
            typeof tu.input === 'string'
              ? tu.input
              : JSON.stringify(tu.input ?? {}),
        },
      })
    } else if (block.type === 'thinking') {
      const thinkingText = (block as unknown as { thinking?: unknown }).thinking
      if (typeof thinkingText === 'string') {
        reasoningContent =
          reasoningContent === undefined
            ? thinkingText
            : `${reasoningContent}\n${thinkingText}`
      }
    }
    // redacted_thinking / provider blocks that cannot map to Chat are ignored
  }

  const assistantMsg: OpenAIChatMessage = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('\n') : null,
  }
  // 注意：空字符串也保留 —— DeepSeek 要求把空 reasoning_content 也原样回传。
  if (reasoningContent !== undefined) {
    assistantMsg.reasoning_content = reasoningContent
  }
  if (toolCalls.length > 0) {
    assistantMsg.tool_calls = toolCalls
  }
  return [assistantMsg]
}

/**
 * 将 (normalized wrapper 消息数组 + system prompt) 转换为 OpenAI Chat 消息数组。
 * 直接消费 Agent 语义的 content blocks —— 不经过 Anthropic 消息中间表示。
 */
export function agentMessagesToOpenAIChatMessages(
  messages: Array<AssistantMessage | UserMessage>,
  systemPrompt?: string,
  options?: { supportsImages?: boolean },
): OpenAIChatMessage[] {
  const supportsImages = options?.supportsImages !== false
  const result: OpenAIChatMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    const inner = (msg as unknown as { message?: { role?: string; content?: AgentMessageContent } }).message
    const role = inner?.role === 'assistant' ? 'assistant' : 'user'
    const content = inner?.content
    for (const m of role === 'assistant'
      ? assistantMessageContentToOpenAIChat(content)
      : userMessageContentToOpenAIChat(content, supportsImages)) {
      pushMergedAssistant(result, m)
    }
  }

  return result
}

// ============================================================================
// Reasoning extraction
// ============================================================================

type ReasoningCarrier = {
  reasoning_content?: string | null
  reasoning?: string | null
  reasoning_text?: string | null
  reasoning_details?: Array<{ text?: string }> | null
} | null | undefined

/**
 * 线序优先级：reasoning_content (DeepSeek/big-pickle) ?? reasoning
 * (nemotron/mimo Zen 模型) ?? reasoning_text ?? reasoning_details[] 拼接。
 * 空字符串是有效信号（DeepSeek 直接作答时返回 ""，空 thinking 块必须往返），
 * 故用 ?? 而非 ||。
 */
export function extractOpenAIChatReasoningText(
  carrier: ReasoningCarrier,
): string | null {
  if (!carrier) return null
  const direct = carrier.reasoning_content ?? carrier.reasoning ?? carrier.reasoning_text ?? null
  if (direct !== null) return direct
  const details = carrier.reasoning_details
  if (Array.isArray(details) && details.length > 0) {
    const combined = details
      .map(part => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
    if (combined !== '') return combined
  }
  return null
}

// ============================================================================
// Usage normalization (OpenAI → runtime contract four fields)
// ============================================================================

export function normalizeOpenAIChatUsage(params: {
  totalInputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): OpenAIChatNormalizedUsage {
  const totalInput = Math.max(0, params.totalInputTokens)
  const cacheRead = Math.min(
    Math.max(0, params.cacheReadTokens ?? 0),
    totalInput,
  )
  const remainingAfterRead = Math.max(0, totalInput - cacheRead)
  const cacheCreation = Math.min(
    Math.max(0, params.cacheWriteTokens ?? 0),
    remainingAfterRead,
  )

  return {
    input_tokens: Math.max(0, remainingAfterRead - cacheCreation),
    output_tokens: Math.max(0, params.outputTokens),
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  }
}

// ============================================================================
// Chat SSE → OpenAIChatStreamEvent
// ============================================================================

function newMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return `msg_${hex}`
}

/** 映射 OpenAI finish_reason → 运行时常量 stop_reason。 */
function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/**
 * 把 OpenAI Chat 流式 chunk 序列适配为 LLMStreamEvent 序列。语义与 legacy
 * Chat 流适配器一致：thinking 块来自 reasoning 系 delta，但不再携带假的
 * Anthropic `signature`；message_delta + message_stop 只在观察到 finish_reason
 * 时下发（@ant 兼容端点常把 trailing usage chunk 放在 finish 之后，故 usage
 * 累计到流末一次性下发）。
 */
export async function* adaptOpenAIChatSSE(
  stream: AsyncIterable<OpenAIChatWireChunk>,
  model: string,
  options?: { includeCacheWriteTokens?: boolean },
): AsyncGenerator<OpenAIChatStreamEvent, void> {
  const messageId = newMessageId()

  let started = false
  let currentContentIndex = -1

  // tool_calls index → { contentIndex, id, name, arguments }
  const toolBlocks = new Map<
    number,
    { contentIndex: number; id: string; name: string; arguments: string }
  >()

  let thinkingBlockOpen = false
  let textBlockOpen = false

  // OpenAI 原始 usage 跨 chunk 累计；归一化后四个字段互斥
  let rawInputTokens = 0
  let outputTokens = 0
  let rawCacheReadTokens = 0
  let rawCacheWriteTokens = 0
  let usage = normalizeOpenAIChatUsage({ totalInputTokens: 0, outputTokens: 0 })

  // 所有未关闭的 content block 索引（用于收尾清理）
  const openBlockIndices = new Set<number>()

  let pendingFinishReason: string | null = null
  let pendingHasToolCalls = false

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta

    // 任意 chunk 都可能携带 usage（include_usage 时通常紧跟流末）
    if (chunk.usage) {
      rawInputTokens = chunk.usage.prompt_tokens ?? rawInputTokens
      outputTokens = chunk.usage.completion_tokens ?? outputTokens

      const details = chunk.usage.prompt_tokens_details
      if (typeof details?.cached_tokens === 'number') {
        rawCacheReadTokens = details.cached_tokens
      }
      if (
        options?.includeCacheWriteTokens &&
        typeof details?.cache_write_tokens === 'number'
      ) {
        rawCacheWriteTokens = details.cache_write_tokens
      } else if (!options?.includeCacheWriteTokens) {
        rawCacheWriteTokens = 0
      }

      usage = normalizeOpenAIChatUsage({
        totalInputTokens: rawInputTokens,
        outputTokens,
        cacheReadTokens: rawCacheReadTokens,
        cacheWriteTokens: rawCacheWriteTokens,
      })
    }

    // 首个 chunk 发 message_start
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            ...usage,
            output_tokens: 0,
          },
        },
      }
    }

    // 只带 usage 的空 chunk 跳过
    if (!delta) continue

    // reasoning 系字段 → thinking 块。空字符串是有效信号，也必须是块（见头注释）。
    const reasoningContent = extractOpenAIChatReasoningText(delta)
    if (reasoningContent != null) {
      if (!thinkingBlockOpen) {
        currentContentIndex++
        thinkingBlockOpen = true
        openBlockIndices.add(currentContentIndex)

        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        }
      }

      if (reasoningContent !== '') {
        yield {
          type: 'content_block_delta',
          index: currentContentIndex,
          delta: {
            type: 'thinking_delta',
            thinking: reasoningContent,
          },
        }
      }
    }

    // text 内容
    if (delta.content != null && delta.content !== '') {
      if (!textBlockOpen) {
        // 先关掉仍开着的 thinking 块
        if (thinkingBlockOpen) {
          yield { type: 'content_block_stop', index: currentContentIndex }
          openBlockIndices.delete(currentContentIndex)
          thinkingBlockOpen = false
        }

        currentContentIndex++
        textBlockOpen = true
        openBlockIndices.add(currentContentIndex)

        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'text', text: '' },
        }
      }

      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'text_delta', text: delta.content },
      }
    }

    // tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0

        if (!toolBlocks.has(tcIndex)) {
          if (thinkingBlockOpen) {
            yield { type: 'content_block_stop', index: currentContentIndex }
            openBlockIndices.delete(currentContentIndex)
            thinkingBlockOpen = false
          }
          if (textBlockOpen) {
            yield { type: 'content_block_stop', index: currentContentIndex }
            openBlockIndices.delete(currentContentIndex)
            textBlockOpen = false
          }

          currentContentIndex++
          const toolId = tc.id || `toolu_${newMessageId().slice(5, 29)}`
          const toolName = tc.function?.name || ''

          toolBlocks.set(tcIndex, {
            contentIndex: currentContentIndex,
            id: toolId,
            name: toolName,
            arguments: '',
          })
          openBlockIndices.add(currentContentIndex)

          yield {
            type: 'content_block_start',
            index: currentContentIndex,
            content_block: {
              type: 'tool_use',
              id: toolId,
              name: toolName,
              input: {},
            },
          }
        }

        const argFragment = tc.function?.arguments
        if (argFragment) {
          const block = toolBlocks.get(tcIndex)!
          block.arguments += argFragment
          yield {
            type: 'content_block_delta',
            index: block.contentIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: argFragment,
            },
          }
        }
      }
    }

    // finish
    if (choice?.finish_reason) {
      if (thinkingBlockOpen) {
        yield { type: 'content_block_stop', index: currentContentIndex }
        openBlockIndices.delete(currentContentIndex)
        thinkingBlockOpen = false
      }
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: currentContentIndex }
        openBlockIndices.delete(currentContentIndex)
        textBlockOpen = false
      }
      for (const [, block] of toolBlocks) {
        if (openBlockIndices.has(block.contentIndex)) {
          yield { type: 'content_block_stop', index: block.contentIndex }
          openBlockIndices.delete(block.contentIndex)
        }
      }

      pendingFinishReason = choice.finish_reason
      pendingHasToolCalls = toolBlocks.size > 0
    }
  }

  // 安全收尾：关闭仍开着的块
  for (const idx of openBlockIndices) {
    yield { type: 'content_block_stop', index: idx }
  }

  // message_delta + message_stop
  if (pendingFinishReason !== null) {
    const stopReason =
      pendingFinishReason === 'length'
        ? 'max_tokens'
        : pendingHasToolCalls
          ? 'tool_use'
          : mapFinishReason(pendingFinishReason)

    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    }

    yield { type: 'message_stop' }
  }
}