/**
 * OpenAI 流式 chunk → Anthropic BetaRawMessageStreamEvent 转换。
 *
 * 映射：
 *   First chunk              → message_start
 *   delta.reasoning_content  → content_block_start(thinking) + thinking_delta + content_block_stop
 *   delta.content            → content_block_start(text) + text_delta + content_block_stop
 *   delta.tool_calls         → content_block_start(tool_use) + input_json_delta + content_block_stop
 *   finish_reason            → message_delta(stop_reason) + message_stop
 *
 * Thinking 支持：
 *   DeepSeek 等端点通过 delta.reasoning_content 输出思维链，映射为 Anthropic
 *   thinking 块。空字符串同样是有效信号（DeepSeek v4 直接作答时返回
 *   reasoning_content: ""，空 thinking 块必须在后续请求中往返，否则 400）。
 *
 * Usage 映射（OpenAI → Anthropic）：
 *   prompt_tokens - cached - cache_write → input_tokens
 *   completion_tokens                     → output_tokens
 *   prompt_tokens_details.cached_tokens   → cache_read_input_tokens
 *   prompt_tokens_details.cache_write_tokens → cache_creation_input_tokens
 *
 *   四个字段在流末的 message_delta 一次性下发，以便捕获 finish_reason 之后
 *   才到达的 trailing usage chunk。
 */
import type { OpenAIStreamChunk } from '../types.js'
import { normalizeOpenAIUsage } from './openaiUsage.js'

export type AnthropicStreamEvent =
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
        usage: {
          input_tokens: number
          output_tokens: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      }
    }
  | {
      type: 'content_block_start'
      index: number
      content_block:
        | { type: 'text'; text: string }
        | { type: 'thinking'; thinking: string; signature: string }
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
      usage: ReturnType<typeof normalizeOpenAIUsage>
    }
  | { type: 'message_stop' }

function newMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return `msg_${hex}`
}

/**
 * 把 OpenAI 流式 chunk 序列适配为 Anthropic 流式事件序列。
 */
export async function* adaptOpenAIStreamToAnthropic(
  stream: AsyncIterable<OpenAIStreamChunk>,
  model: string,
  options?: { includeCacheWriteTokens?: boolean },
): AsyncGenerator<AnthropicStreamEvent, void> {
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

  // OpenAI 原始 usage 跨 chunk 累计；归一化后四个 Anthropic 字段互斥
  let rawInputTokens = 0
  let outputTokens = 0
  let rawCacheReadTokens = 0
  let rawCacheWriteTokens = 0
  let usage = normalizeOpenAIUsage({ totalInputTokens: 0, outputTokens: 0 })

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

      usage = normalizeOpenAIUsage({
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

    // reasoning_content → thinking 块。空字符串是有效信号，也必须是块（见头注释）。
    const reasoningContent = delta.reasoning_content
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
            signature: '',
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
        const tcIndex = tc.index

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

/** 映射 OpenAI finish_reason → Anthropic stop_reason。 */
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