/**
 * Anthropic 消息 → OpenAI Chat Completions 消息转换。
 *
 * 关键转换：
 * - system prompt → role: "system" 消息（前置）
 * - tool_use 块 → assistant 消息的 tool_calls[]
 * - tool_result 块 → role: "tool" 消息（必须在任何 user 消息之前）
 * - thinking 块 → reasoning_content（含空字符串原样保留 —— DeepSeek 要求往返，
 *   否则下一轮返回 400 "reasoning_content ... must be passed back"）
 * - image/document 块 → image_url / 降级为 text
 * - cache_control 等无关字段丢弃
 */
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  OpenAIMessage,
} from '../types.js'

export interface ConvertMessagesOptions {
  /** 保留 thinking 块为 reasoning_content。现在恒为 true，保留参数仅为兼容。 */
  enableThinking?: boolean
}

/** OpenAI 要求 user/assistant 交替；Anthropic 历史可能含连续 assistant 回合，需合并。 */
function pushMergedAssistant(
  result: OpenAIMessage[],
  msg: OpenAIMessage,
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
 */
function normalizeToolResultContent(
  content: unknown,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const textParts: string[] = []
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> =
    []
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
      if (url) {
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

export function convertInternalUserMessage(
  msg: AnthropicMessage,
): OpenAIMessage[] {
  if (typeof msg.content === 'string') {
    return [{ role: 'user', content: msg.content }]
  }
  if (!Array.isArray(msg.content)) {
    return [{ role: 'user', content: '' }]
  }

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> =
    []
  const toolResults: OpenAIMessage[] = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push({
        type: 'text',
        text: String((block as { text: string }).text ?? ''),
      })
    } else if (block.type === 'image') {
      const url = base64ImageUrl(
        (
          block as {
            source?: { type?: string; media_type?: string; data?: string }
          }
        ).source ?? {},
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
      toolResults.push({
        role: 'tool',
        content: normalizeToolResultContent(
          (block as { content: unknown }).content,
        ),
        tool_call_id: (block as { tool_use_id: string }).tool_use_id,
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

export function convertInternalAssistantMessage(
  msg: AnthropicMessage,
): OpenAIMessage[] {
  if (typeof msg.content === 'string') {
    return [{ role: 'assistant', content: msg.content }]
  }
  if (!Array.isArray(msg.content)) {
    return [{ role: 'assistant', content: '' }]
  }

  const textParts: string[] = []
  const toolCalls: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }> = []
  let reasoningContent: string | undefined

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push((block as { text: string }).text ?? '')
    } else if (block.type === 'tool_use') {
      const tu = block as {
        id: string
        name: string
        input: Record<string, unknown>
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
    // redacted_thinking / server_tool_use 等无法映射的块忽略
  }

  const assistantMsg: OpenAIMessage = {
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
 * 将 (Anthropic 消息数组 + system prompt) 转换为 OpenAI 消息数组。
 *
 * @param messages  Anthropic Messages API 的消息（已解析自请求体）
 * @param systemPrompt  system 文本（若有则前置为 system 消息）
 * @param _options  保留参数；thinking 块现在恒被保留为 reasoning_content
 */
export function convertAnthropicMessagesToOpenAI(
  messages: AnthropicMessage[],
  systemPrompt?: string,
  _options?: ConvertMessagesOptions,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      for (const m of convertInternalUserMessage(msg)) {
        pushMergedAssistant(result, m)
      }
    } else if (msg.role === 'assistant') {
      for (const m of convertInternalAssistantMessage(msg)) {
        pushMergedAssistant(result, m)
      }
    }
  }

  return result
}