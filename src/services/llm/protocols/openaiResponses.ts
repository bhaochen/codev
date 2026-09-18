/**
 * OpenAI Responses 协议客户端 — 原生 POST /responses wire。
 *
 * 与 openai-chat（历史 Anthropic 形状转换管线）完全分离：
 * 请求与响应两侧都直接使用 OpenAI Responses API 的 native 结构，
 * 不再经过任何 Anthropic SDK 的 wire 类型或转换工具。
 *
 * 转换边界：
 *   LLMRequest(provider-neutral)
 *     ↓ buildOpenAIResponsesBody
 *   OpenAI Responses native request { instructions, input, tools, ... }
 *
 *   OpenAI Responses SSE
 *     ↓ adaptOpenAIResponsesSSE
 *   LLMStreamEvent（Agent 语义 stream contract,无 provider shape）
 *     ↓ queryOpenAIResponses 外层聚合
 *   AssistantMessage
 *
 * OpenAI-specific 的 wire 表达只存在于本文件。
 */
import type { LLMRoute } from '../types.js'
import type {
  LLMRequest,
  LLMRequestConfig,
  LLMRuntimeContext,
} from '../runtime/types.js'
import type {
  StreamEvent,
  AssistantMessage,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { APIUserAbortError } from '@anthropic-ai/sdk/error'
import { randomUUID } from 'crypto'
import { httpRequest } from '../transport/http.js'
import { parseSSERaw, type RawSSEEvent } from '../transport/sse.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import type { AgentId } from '../../../types/ids.js'
import type {
  AgentContentBlock,
  AgentImageBlock,
} from '../../../types/agentMessage.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { isAbortError } from '../../../utils/errors.js'
import { resolveOpenAIMaxTokens } from '../utils/requestBody.js'
import {
  formatOpenAIPromptCacheKey,
  updateOpenAIUsage,
} from '../utils/openaiShared.js'
import { resolveAuth } from '../auth/resolveAuth.js'
import { createOpencodeId, getOpencodeProjectId, getOpencodeUserAgent } from '../../api/opencodeUserAgent.js'

// ============================================================================
// Native OpenAI Responses wire types (local to this adapter)
// ============================================================================

export type OpenAIResponsesUsage = {
  input_tokens: number
  output_tokens: number
  input_tokens_details?: {
    cached_tokens?: number
    text_tokens?: number
  }
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
}

export type OpenAIResponsesInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string }
  | { type: 'reasoning'; summary: Array<{ type: 'summary_text'; text: string }> }

export type OpenAIResponsesInputItem =
  | {
      type: 'message'
      role: 'user' | 'assistant'
      content: OpenAIResponsesInputPart[]
    }
  | {
      type: 'function_call'
      id?: string
      call_id: string
      name: string
      arguments: string
    }
  | { type: 'function_call_output'; call_id: string; output: string }

export type OpenAIResponsesFunctionTool = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
  parallel_tool_calls?: boolean
}

export type OpenAIResponsesRequestBody = {
  model: string
  instructions?: string
  input: OpenAIResponsesInputItem[]
  tools?: OpenAIResponsesFunctionTool[]
  tool_choice?: unknown
  max_output_tokens?: number
  temperature?: number
  reasoning?: { effort: 'low' | 'medium' | 'high' }
  prompt_cache_key?: string
  stream: boolean
  store?: boolean
}

/** 累计 usage（含原生 reasoning_tokens 明细）。 */
type UsageAccumulator = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  reasoning_tokens?: number
}

// ============================================================================
// URL
// ============================================================================

export function responsesUrl(base: string): string {
  const b = base.replace(/\/$/, '')
  if (b.endsWith('/v1')) return `${b}/responses`
  return `${b}/v1/responses`
}

// ============================================================================
// Tool schema → native Responses function tool
// ============================================================================

/**
 * `toolToAPISchema` 产物是 Anthropic-shaped（name/description/input_schema），
 * 这里只投影出建 plain schema 再组装 Responses native 的扁平 function tool；
 * advisor / computer-use 等非 function 风格 schema 直接丢弃
 * （OpenAI function calling 不适用这类客户端工具）。
 */
function responsesToolFromSchema(
  name: string,
  description: string,
  inputSchema: Record<string, unknown> | undefined,
  strict: boolean | undefined,
  disableParallel: boolean | undefined,
): OpenAIResponsesFunctionTool {
  const parameters = inputSchema ?? { type: 'object', properties: {} }
  return {
    type: 'function',
    name,
    description,
    parameters: sanitizeJsonSchema(parameters),
    ...(strict === true && { strict: true }),
    ...(disableParallel === true && { parallel_tool_calls: false }),
  }
}

/**
 * 递归清洗 JSON Schema：`const` → 单元素 `enum`。
 * 大量 OpenAI 兼容 / 托管端点不识别 JSON Schema 的 `const` 关键字。
 */
function sanitizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema
  const result: Record<string, unknown> = { ...schema }
  if ('const' in result) {
    result.enum = [result.const]
    delete result.const
  }
  const objectKeys = ['properties', 'definitions', '$defs', 'patternProperties'] as const
  for (const key of objectKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object') {
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
        sanitized[k] = v && typeof v === 'object' ? sanitizeJsonSchema(v as Record<string, unknown>) : v
      }
      result[key] = sanitized
    }
  }
  const singleKeys = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'] as const
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

// ============================================================================
// tool_choice → native Responses form
// ============================================================================

function llmToolChoiceToResponses(tc: LLMRequestConfig['toolChoice']): unknown {
  if (!tc) return undefined
  switch (tc.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return { type: 'function', name: tc.name }
    default:
      return undefined
  }
}

// ============================================================================
// Reasoning config → native `reasoning` field
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
 * LLMRequestConfig.thinking / context.effortValue → OpenAI `reasoning.effort`。
 * OpenAI 仅支持 low/medium/high;Anthropic 的 numeric effort 不映射（它只对
 * 1P Anthropic 模型有意义）。disabled 或全局无信号时不下发 reasoning——
 * 非 reasoning 模型收到 reasoning 参数会 400。
 */
function llmThinkingToOpenAIReasoning(
  config: LLMRequestConfig,
  context: LLMRuntimeContext,
): { effort: 'low' | 'medium' | 'high' } | undefined {
  if (config.thinking?.type === 'disabled') return undefined
  const effort = context.effortValue
  if (typeof effort === 'string') {
    const level = OPENAI_REASONING_EFFORT[effort]
    if (level) return { effort: level }
  }
  if (config.thinking?.type === 'enabled') {
    return { effort: 'high' }
  }
  return undefined
}

// ============================================================================
// Agent content blocks → native Responses input items
// ============================================================================

function imageBlockToResponsesImageUrl(block: AgentImageBlock): string | undefined {
  const source = block.source
  if (source.type === 'base64' && source.media_type && source.data) {
    return `data:${source.media_type};base64,${source.data}`
  }
  if (source.type === 'url' && source.url) {
    return source.url
  }
  return undefined
}

function toolResultToResponsesOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block && block.type === 'text' ? block.text : ''))
    .filter(text => text.length > 0)
    .join('\n')
}

/**
 * OpenAI Responses 用扁平 item 数组承载对话历史（区别于 Chat 的 messages）：
 * - 消息 → `message` item（user 用 input_text/input_image,assistant 用 output_text）
 * - assistant tool_use  → `function_call` item（call_id 保留 Agent tool_use.id）
 * - user tool_result   → `function_call_output` item（call_id 往返匹配）
 * - thinking 块 → assistant 消息内的 `reasoning` summary part（仅当有文本时附带）
 */
function normalizedMessageToResponsesItems(
  msg: {
    type: string
    message: { content?: unknown }
  },
  items: OpenAIResponsesInputItem[],
): void {
  const content = msg.message?.content
  if (typeof content === 'string') {
    items.push({ type: 'message', role: msg.type === 'assistant' ? 'assistant' : 'user', content: [{ type: 'input_text', text: content }] })
    return
  }
  if (!Array.isArray(content)) return

  // 先聚合消息 part（message item 必须先于属于它的 function_call/function_call_output
  // items 出现,保持 OpenAI Responses 的 input 顺序契约）。
  if (msg.type === 'user') {
    const parts: OpenAIResponsesInputPart[] = []
    const outputs: OpenAIResponsesInputItem[] = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        outputs.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: toolResultToResponsesOutput(block.content),
        })
      } else if (block.type === 'text') {
        parts.push({ type: 'input_text', text: block.text })
      } else if (block.type === 'image') {
        const url = imageBlockToResponsesImageUrl(block)
        if (url) parts.push({ type: 'input_image', image_url: url })
      }
      // document —— 与 openai-chat 保持同能力：base64 文档降级丢弃,文本型 source 并入文本
    }
    if (parts.length > 0) {
      items.push({ type: 'message', role: 'user', content: parts })
    }
    items.push(...outputs)
    return
  }

  const parts: OpenAIResponsesInputPart[] = []
  const thinkingTexts: string[] = []
  const calls: OpenAIResponsesInputItem[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'output_text', text: block.text })
    } else if (block.type === 'tool_use') {
      calls.push({
        type: 'function_call',
        call_id: block.id,
        ...(typeof block.id === 'string' ? { id: block.id } : {}),
        name: block.name,
        arguments:
          typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      })
    } else if (block.type === 'thinking') {
      thinkingTexts.push(block.thinking)
    }
  }
  if (thinkingTexts.length > 0 && parts.length > 0) {
    parts.push({
      type: 'reasoning',
      summary: thinkingTexts.map(text => ({ type: 'summary_text', text })),
    })
  }
  if (parts.length > 0) {
    items.push({ type: 'message', role: 'assistant', content: parts })
  }
  items.push(...calls)
}

// ============================================================================
// Request body builder（纯构建,不执行网络）
// ============================================================================

export async function buildOpenAIResponsesBody(
  route: LLMRoute,
  request: LLMRequest,
): Promise<OpenAIResponsesRequestBody> {
  const { messages, systemPrompt, tools, config, context } = request
  const model = route.model

  const messagesForAPI = normalizeMessagesForAPI(messages, tools)
  const toolSchemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: context.getToolPermissionContext,
        tools,
        agents: context.agents,
        allowedAgentTypes: context.allowedAgentTypes,
        model,
      }),
    ),
  )

  // advisor / computer-use 等 Anhropic 风味客户端工具不适合 function calling,
  // 与 openai-chat 一致地丢弃（Anthropic 路径才把它们当 extraToolSchema 发）。
  const openaiTools: OpenAIResponsesFunctionTool[] = toolSchemas
    .filter(t => {
      const anyT = t as unknown as Record<string, unknown>
      return anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
    })
    .map(t => {
      const anyT = t as unknown as {
        name?: string
        description?: string
        input_schema?: Record<string, unknown>
        strict?: boolean
      }
      return responsesToolFromSchema(
        anyT.name ?? '',
        anyT.description ?? '',
        anyT.input_schema,
        anyT.strict,
        config.toolChoice?.disable_parallel_tool_use,
      )
    })

  const systemText = systemPrompt?.join('\n')
  const input: OpenAIResponsesInputItem[] = []
  for (const msg of messagesForAPI) {
    normalizedMessageToResponsesItems(
      msg as unknown as { type: string; message: { content?: unknown } },
      input,
    )
  }

  const { upperLimit } = getModelMaxOutputTokens(model)
  // opencode 模型按目录 limit.output 裁剪 max_tokens（同 openai-chat）
  let effectiveUpperLimit = upperLimit
  if (route.provider === 'opencode') {
    try {
      const { getOpencodeModelMaxTokens } = await import('../../api/opencodeClient.js')
      const catalogCap = getOpencodeModelMaxTokens(model)
      if (typeof catalogCap === 'number' && catalogCap >= 4_096) {
        effectiveUpperLimit = Math.min(upperLimit, catalogCap)
      }
    } catch {}
  }
  const maxOutputTokens = resolveOpenAIMaxTokens(effectiveUpperLimit, config.maxOutputTokens)
  const promptCacheKey = formatOpenAIPromptCacheKey(getSessionId())
  const reasoning = llmThinkingToOpenAIReasoning(config, context)
  const toolChoice = llmToolChoiceToResponses(config.toolChoice)

  const body: OpenAIResponsesRequestBody = {
    model,
    ...(systemText ? { instructions: systemText } : {}),
    input,
    stream: true,
    store: false,
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    max_output_tokens: maxOutputTokens,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(openaiTools.length > 0
      ? { tools: openaiTools, ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}) }
      : {}),
    ...(reasoning ? { reasoning } : {}),
  }
  return body
}

// ============================================================================
// Native SSE → LLMStreamEvent adapter
// ============================================================================

export type OpenAIResponsesStreamEvent =
  | {
      type: 'message_start'
      message: {
        id: string
        role: 'assistant'
        content: []
        model: string
        stop_reason: null
        stop_sequence: null
        usage: UsageAccumulator
      }
    }
  | {
      type: 'content_block_start'
      index: number
      content_block: AgentContentBlock
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: { stop_reason: string | null; stop_sequence: null }
      usage: OpenAIResponsesUsage
    }
  | { type: 'message_stop' }

const EMPTY_USAGE: UsageAccumulator = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

function emptyOpenAIResponsesUsage(): OpenAIResponsesUsage {
  return { input_tokens: 0, output_tokens: 0 }
}

/**
 * 解析 native OpenAI Responses SSE 为 LLM service 层 stream event。
 * 不做任何 Anthropic 构造：
 * - output_text part → text 块
 * - function_call item → tool_use 块（id = OpenAI call_id,name = 工具名）
 * - reasoning summary → thinking 块（无 signature —— OpenAI 无此概念）
 * - response.completed/incomplete/failed → message_delta(stop_reason+usage)+message_stop
 *
 * block 生命周期：start/delta 事件到达即产出，直到收尾事件
 * （response.output_item.done 或 response.completed）才 close —— 兼容
 * 省略某些中间事件的兼容端点。
 */
export async function* adaptOpenAIResponsesSSE(
  rawStream: AsyncIterable<RawSSEEvent>,
  model: string,
): AsyncGenerator<OpenAIResponsesStreamEvent, void> {
  let responseId: string | undefined
  let started = false
  let nextIndex = 0
  const textBlocksByPart = new Map<string, number>()
  const reasoningBlocksByItem = new Map<string, number>()
  const toolUseBlocksByItem = new Map<string, number>()
  const openBlockIndexes = new Set<number>()
  let usage: OpenAIResponsesUsage = emptyOpenAIResponsesUsage()
  let status: string | undefined

  const newMessageId = (): string => {
    if (responseId) return responseId
    const bytes = crypto.getRandomValues(new Uint8Array(12))
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return `msg_${hex}`
  }

  const messageStart = function* (): Generator<
    Extract<OpenAIResponsesStreamEvent, { type: 'message_start' }>
  > {
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: {
          id: newMessageId(),
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { ...EMPTY_USAGE },
        },
      }
    }
  }

  const startTextBlock = function* (
    itemId: string,
    contentIndex: number,
  ): Generator<Extract<OpenAIResponsesStreamEvent, { type: 'content_block_start' }>> {
    const key = `${itemId}:${contentIndex}`
    if (textBlocksByPart.has(key)) return
    const index = nextIndex++
    textBlocksByPart.set(key, index)
    openBlockIndexes.add(index)
    yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
  }

  const startThinkingBlock = function* (
    itemId: string,
  ): Generator<Extract<OpenAIResponsesStreamEvent, { type: 'content_block_start' }>> {
    if (reasoningBlocksByItem.has(itemId)) return
    const index = nextIndex++
    reasoningBlocksByItem.set(itemId, index)
    openBlockIndexes.add(index)
    yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }
  }

  const startToolUseBlock = function* (
    itemId: string,
    callId: string,
    name: string,
  ): Generator<Extract<OpenAIResponsesStreamEvent, { type: 'content_block_start' }>> {
    if (toolUseBlocksByItem.has(itemId)) return
    const index = nextIndex++
    toolUseBlocksByItem.set(itemId, index)
    openBlockIndexes.add(index)
    yield {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: callId, name, input: '' },
    }
  }

  const stopBlock = function* (
    index: number,
  ): Generator<Extract<OpenAIResponsesStreamEvent, { type: 'content_block_stop' }>> {
    if (openBlockIndexes.delete(index)) {
      yield { type: 'content_block_stop', index }
    }
  }

  const extractDeltaText = (parsed: Record<string, unknown>): string | undefined => {
    const delta = (parsed as { delta?: unknown }).delta
    if (typeof delta === 'string') return delta
    const text = (parsed as { text?: unknown }).text
    if (typeof text === 'string') return text
    if (delta && typeof delta === 'object') {
      const d = delta as Record<string, unknown>
      if (typeof d.text === 'string') return d.text
      if (typeof d.delta === 'string') return d.delta
    }
    return undefined
  }

  const extractUsage = (parsed: Record<string, unknown>): OpenAIResponsesUsage | undefined => {
    const root = (parsed as { response?: Record<string, unknown> }).response ?? parsed
    const u =
      (root as { usage?: Record<string, unknown> }).usage ??
      (parsed as { usage?: Record<string, unknown> }).usage
    if (!u || typeof u !== 'object') return undefined
    const uu = u as Record<string, unknown>
    return {
      input_tokens: (uu.input_tokens as number) ?? 0,
      output_tokens: (uu.output_tokens as number) ?? 0,
      ...(uu.input_tokens_details !== undefined
        ? { input_tokens_details: uu.input_tokens_details }
        : {}),
      ...(uu.output_tokens_details !== undefined
        ? { output_tokens_details: uu.output_tokens_details }
        : {}),
      ...(uu.total_tokens !== undefined ? { total_tokens: uu.total_tokens as number } : {}),
    }
  }

  const finish = function* (
    parsed: Record<string, unknown>,
  ): Generator<OpenAIResponsesStreamEvent, void> {
    for (const e of messageStart()) yield e
    for (const index of [...openBlockIndexes]) {
      yield { type: 'content_block_stop', index }
      openBlockIndexes.delete(index)
    }
    const u = extractUsage(parsed)
    if (u) usage = u
    const finalStatus = status ?? 'completed'
    const stopReason = finalStatus === 'incomplete' ? 'max_tokens' : 'end_turn'
    const usageParts: OpenAIResponsesStreamEvent & { type: 'message_delta' } = {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { ...usage },
    }
    yield usageParts
    yield { type: 'message_stop' }
  }

  for await (const raw of rawStream) {
    const dataStr = raw.data.trim()
    if (dataStr === '') continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(dataStr) as Record<string, unknown>
    } catch {
      continue
    }

    const eventType = (raw.event ?? (parsed.type as string) ?? '') as string

    switch (eventType) {
      case 'response.created':
      case 'response.queued':
      case 'response.in_progress': {
        const rid = (parsed as { response?: { id?: string } }).response?.id
        if (rid) responseId = rid
        if (eventType === 'response.created' || eventType === 'response.in_progress') {
          for (const e of messageStart()) yield e as never
        }
        continue
      }

      case 'response.output_item.added': {
        const item = (parsed as { item?: Record<string, unknown> }).item
        if (!item) continue
        const id = item.id as string | undefined
        if (item.type === 'function_call' && id) {
          const callId = (item.call_id as string | undefined) ?? id
          const name = (item.name as string | undefined) ?? ''
          for (const e of messageStart()) yield e as never
          for (const e of startToolUseBlock(id, callId, name)) yield e as never
        }
        // message item 本身不产生 block,等 content_part.added
        continue
      }

      case 'response.content_part.added': {
        const part = (parsed as { part?: Record<string, unknown> }).part
        const itemId = parsed.item_id as string | undefined
        if (!part || !itemId) continue
        const contentIndex = (parsed.content_index as number | undefined) ?? 0
        if (part.type === 'output_text') {
          for (const e of messageStart()) yield e as never
          for (const e of startTextBlock(itemId, contentIndex)) yield e as never
        } else if (part.type === 'reasoning') {
          for (const e of messageStart()) yield e as never
          for (const e of startThinkingBlock(itemId)) yield e as never
        }
        continue
      }

      case 'response.output_text.delta': {
        const delta = extractDeltaText(parsed)
        if (delta == null) continue
        for (const e of messageStart()) yield e as never
        const itemId = parsed.item_id as string | undefined
        const contentIndex = (parsed.content_index as number | undefined) ?? 0
        if (itemId) {
          for (const e of startTextBlock(itemId, contentIndex)) yield e as never
        }
        const index =
          (itemId ? textBlocksByPart.get(`${itemId}:${contentIndex}`) : undefined) ??
          (itemId ? textBlocksByPart.get(`${itemId}:0`) : undefined)
        if (index === undefined) continue
        if (delta !== '') {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: delta },
          }
        }
        continue
      }

      case 'response.reasoning_summary_text.delta': {
        const delta = extractDeltaText(parsed)
        const summary = (parsed as { summary?: Array<{ text?: string }> }).summary
        if (delta == null && summary == null) continue
        for (const e of messageStart()) yield e as never
        const itemId = parsed.item_id as string | undefined
        if (itemId) {
          for (const e of startThinkingBlock(itemId)) yield e as never
        }
        const index = itemId ? reasoningBlocksByItem.get(itemId) : undefined
        if (index === undefined) continue
        const text = delta ?? summary?.map(s => s.text ?? '').join('\n') ?? ''
        if (text !== '') {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: text },
          }
        }
        continue
      }

      case 'response.function_call_arguments.delta': {
        const delta = (parsed as { delta?: unknown }).delta
        if (typeof delta !== 'string') continue
        for (const e of messageStart()) yield e as never
        const itemId = parsed.item_id as string | undefined
        if (!itemId) continue
        let index = toolUseBlocksByItem.get(itemId)
        if (index === undefined && (parsed as { name?: string }).name) {
          // 兼容路径:跳过 output_item.added 直接发 arguments.delta
          const callId = (parsed as { call_id?: string }).call_id ?? itemId
          const name = (parsed as { name?: string }).name ?? ''
          for (const e of startToolUseBlock(itemId, callId, name)) yield e as never
          index = toolUseBlocksByItem.get(itemId)
        }
        if (index === undefined) continue
        if (delta !== '') {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: delta },
          }
        }
        continue
      }

      case 'response.output_item.done': {
        const item = (parsed as { item?: Record<string, unknown> }).item
        const itemId = (item?.id as string | undefined) ?? (parsed.item_id as string | undefined)
        if (!item || !itemId) continue
        if (item.type === 'function_call') {
          for (const e of messageStart()) yield e as never
          const name = (item.name as string | undefined) ?? ''
          const callId = (item.call_id as string | undefined) ?? itemId
          const args = (item.arguments as string | undefined) ?? ''
          if (!toolUseBlocksByItem.has(itemId)) {
            // 完整 arguments 只在 done 里出现（无流式 arguments）→ 懒建块并一次性供给
            for (const e of startToolUseBlock(itemId, callId, name)) yield e as never
            const index = toolUseBlocksByItem.get(itemId)
            if (index !== undefined && args !== '') {
              yield {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: args },
              }
            }
          }
          const index = toolUseBlocksByItem.get(itemId)
          if (index !== undefined) {
            for (const e of stopBlock(index)) yield e as never
            toolUseBlocksByItem.delete(itemId)
          }
        } else if (item.type === 'message') {
          // 先捕获“已流式产生过”的块,避免下面兜底供给时把同一内容发两遍。
          const streamedTextKeys = [...textBlocksByPart.keys()].filter(k =>
            k.startsWith(`${itemId}:`),
          )
          const wasStreamedReasoning = reasoningBlocksByItem.has(itemId)
          for (const key of streamedTextKeys) {
            const index = textBlocksByPart.get(key)!
            for (const e of stopBlock(index)) yield e as never
            textBlocksByPart.delete(key)
          }
          if (wasStreamedReasoning) {
            const reasonIndex = reasoningBlocksByItem.get(itemId)!
            for (const e of stopBlock(reasonIndex)) yield e as never
            reasoningBlocksByItem.delete(itemId)
          }
          // 兼容只发 output_item.done 的端点：已流式产生的块不重复供给,
          // 仅在块从未 start 过（无部分事件）时从 done 的完整 item 兜底填充。
          const parts = (item.content as Array<Record<string, unknown>> | undefined) ?? []
          for (const part of parts) {
            if (part.type === 'output_text') {
              const contentIndex = (part as { index?: number }).index ?? 0
              if (typeof part.text !== 'string' || part.text === '') continue
              const key = `${itemId}:${contentIndex}`
              if (streamedTextKeys.includes(key)) continue
              for (const e of startTextBlock(itemId, contentIndex)) yield e as never
              const idx = textBlocksByPart.get(key)
              if (idx !== undefined) {
                yield {
                  type: 'content_block_delta',
                  index: idx,
                  delta: { type: 'text_delta', text: part.text },
                }
                for (const e of stopBlock(idx)) yield e as never
                textBlocksByPart.delete(key)
              }
            } else if (part.type === 'reasoning') {
              if (wasStreamedReasoning) continue
              const summaries = (part as { summary?: Array<{ text?: string }> }).summary ?? []
              if (summaries.length === 0) continue
              for (const e of startThinkingBlock(itemId)) yield e as never
              const idx = reasoningBlocksByItem.get(itemId)
              if (idx !== undefined) {
                const text = summaries.map(s => s.text ?? '').join('\n')
                yield {
                  type: 'content_block_delta',
                  index: idx,
                  delta: { type: 'thinking_delta', thinking: text },
                }
                for (const e of stopBlock(idx)) yield e as never
                reasoningBlocksByItem.delete(itemId)
              }
            } else if (part.type === 'function_call') {
              if (toolUseBlocksByItem.has(itemId)) continue
              const callId = (part as { call_id?: string }).call_id ?? itemId
              const name = (part as { name?: string }).name ?? ''
              for (const e of startToolUseBlock(itemId, callId, name)) yield e as never
              const idx = toolUseBlocksByItem.get(itemId)
              const args = (part as { arguments?: string }).arguments ?? ''
              if (idx !== undefined && args !== '') {
                yield {
                  type: 'content_block_delta',
                  index: idx,
                  delta: { type: 'input_json_delta', partial_json: args },
                }
              }
              if (idx !== undefined) {
                for (const e of stopBlock(idx)) yield e as never
                toolUseBlocksByItem.delete(itemId)
              }
            }
          }
        }
        continue
      }

      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const responseObj = (parsed as { response?: Record<string, unknown> }).response
        status = (parsed.status as string | undefined) ?? (responseObj?.status as string | undefined)
        if (responseObj?.id) responseId = responseObj.id as string
        for (const e of finish(parsed)) yield e as never
        return
      }

      default:
        continue
    }
  }

  // 流结束但未收到 completed/incomplete —— 兜底收尾
  if (started) {
    for (const index of [...openBlockIndexes]) {
      yield { type: 'content_block_stop', index }
      openBlockIndexes.delete(index)
    }
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { ...usage },
    }
    yield { type: 'message_stop' }
  }
}

// ============================================================================
// Generator
// ============================================================================

export async function* queryOpenAIResponses(
  route: LLMRoute,
  request: LLMRequest,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { signal, config, context } = request
  let ttftMs = 0
  const start = Date.now()
  let usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_tokens: 0,
  }
  let stopReason: string | null = null
  let maxTokens = 0
  try {
    const model = route.model
    const endpoint = route.endpoint ?? ''
    if (!endpoint) throw new Error(`openai-responses route missing endpoint for provider ${route.provider}`)
    const cred = resolveAuth(route.provider)
    const body = await buildOpenAIResponsesBody(route, request)
    maxTokens = body.max_output_tokens ?? 0
    logForDebugging(
      `[OpenAIResponses] provider=${route.provider} model=${model} endpoint=${endpoint} tools=${body.tools?.length ?? 0} items=${body.input.length} reasoning=${body.reasoning ? 'on' : 'off'}`,
    )

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': route.provider === 'opencode' ? getOpencodeUserAgent() : 'codev',
    }
    if (route.provider === 'opencode') {
      headers['x-opencode-client'] = 'cli'
      headers['x-opencode-project'] = await getOpencodeProjectId()
      headers['x-opencode-session'] = createOpencodeId('ses')
      headers['x-opencode-request'] = createOpencodeId('msg')
    }
    if (cred.type === 'bearer') headers.Authorization = `Bearer ${cred.token}`
    else headers.Authorization = 'Bearer public'

    const fetchOverride = context.fetchOverride as unknown as typeof fetch | undefined
    const url = endpoint.includes('/responses') ? endpoint : responsesUrl(endpoint)
    const response = await httpRequest(
      { url, method: 'POST', headers, body: JSON.stringify(body), signal },
      fetchOverride,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Upstream ${route.provider} failed (${response.status})${text ? `: ${text.slice(0, 800)}` : ''}`)
    }
    if (!response.body) throw new Error('Upstream response missing body')

    const adaptedStream = adaptOpenAIResponsesSSE(parseSSERaw(response.body), model)
    const newMessages: AssistantMessage[] = []
    const contentBlocks: Record<number, Record<string, unknown>> = {}
    let partialMessage: {
      id: string
      role: 'assistant'
      content: []
      model: string
      stop_reason: null
      stop_sequence: null
      usage: UsageAccumulator
    } | null = null

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message?.usage) {
            usage = updateOpenAIUsage(
              usage,
              event.message.usage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            ) as typeof usage
          }
          break
        }
        case 'content_block_start': {
          const idx = event.index
          const cb = event.content_block
          if (cb.type === 'tool_use') contentBlocks[idx] = { ...(cb as unknown as Record<string, unknown>), input: '' }
          else if (cb.type === 'text') contentBlocks[idx] = { ...(cb as unknown as Record<string, unknown>), text: '' }
          else if (cb.type === 'thinking') contentBlocks[idx] = { ...(cb as unknown as Record<string, unknown>), thinking: '' }
          else contentBlocks[idx] = { ...(cb as unknown as Record<string, unknown>) }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const block = contentBlocks[idx] as Record<string, unknown> | undefined
          if (!block) break
          const delta = event.delta
          if (delta.type === 'text_delta') block.text = ((block.text as string) || '') + delta.text
          else if (delta.type === 'input_json_delta') block.input = ((block.input as string) || '') + delta.partial_json
          else if (delta.type === 'thinking_delta') block.thinking = ((block.thinking as string) || '') + delta.thinking
          break
        }
        case 'content_block_stop': {
          const contentBlock = contentBlocks[event.index]
          if (!contentBlock || !partialMessage) break
          const m: AssistantMessage = {
            message: {
              ...partialMessage,
              content: normalizeContentFromAPI(
                [contentBlock] as unknown as AgentContentBlock[],
                request.tools,
                context.agentId as AgentId | undefined,
              ),
            },
            requestId: undefined,
            type: 'assistant',
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          } as unknown as AssistantMessage
          newMessages.push(m)
          yield m
          break
        }
        case 'message_delta': {
          if (event.usage) {
            usage = updateOpenAIUsage(
              usage,
              event.usage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            ) as typeof usage
            if (event.usage.output_tokens_details?.reasoning_tokens) {
              usage.reasoning_tokens = event.usage.output_tokens_details.reasoning_tokens
            }
          }
          if (event.delta?.stop_reason != null) stopReason = event.delta.stop_reason
          const lastMsg = newMessages.at(-1) as
            | (AssistantMessage & { message: { usage?: typeof usage; stop_reason?: string | null } })
            | undefined
          if (lastMsg) {
            lastMsg.message.usage = { ...usage }
            lastMsg.message.stop_reason = stopReason
          }
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(model, usage as unknown as Parameters<typeof calculateUSDCost>[1])
            addToTotalSessionCost(costUSD, usage as unknown as Parameters<typeof addToTotalSessionCost>[1], context.model)
          }
          break
        }
        case 'message_stop':
          break
      }
      yield { type: 'stream_event', event, ...(event.type === 'message_start' ? { ttftMs } : undefined) } as unknown as StreamEvent
    }

    const lastMsg = newMessages.at(-1) as
      | (AssistantMessage & { message: { content: AgentContentBlock[]; usage?: unknown; stop_reason?: string | null } })
      | undefined
    const lastHasToolUse = (lastMsg?.message.content ?? []).some(block => block.type === 'tool_use')
    if (stopReason === null && !lastHasToolUse) {
      if (lastMsg) {
        lastMsg.message.usage = { ...usage } as never
        lastMsg.message.stop_reason = 'max_tokens'
      }
      yield createAssistantAPIErrorMessage({
        content: `Upstream ${route.provider} response exceeded ${maxTokens} tokens`,
        apiError: 'max_output_tokens' as never,
        error: 'max_output_tokens' as never,
      })
    }
  } catch (error) {
    if (isAbortError(error)) throw error instanceof APIUserAbortError ? error : new APIUserAbortError()
    const msg = error instanceof Error ? error.message : String(error)
    yield createAssistantAPIErrorMessage({ content: `API Error: ${msg}`, apiError: 'api_error', error })
  }
}