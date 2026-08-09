/**
 * OpenAI SSE 流传输层：
 * - parseOpenAIStream：把 OpenAI Chat Completions SSE 原始字节流解析为 chunk 序列
 * - convertOpenAIStreamToAnthropic：解析 → 适配为 Anthropic 事件 → 序列化为
 *   Anthropic 原生 SSE（`event:` + `data:` 行），供 @anthropic-ai/sdk 直接消费。
 */
import type { OpenAIStreamChunk } from '../types.js'
import {
  adaptOpenAIStreamToAnthropic,
  type AnthropicStreamEvent,
} from './openaiStreamAdapter.js'

/**
 * 解析 OpenAI SSE 流（`data: <json>` 行）为 chunk 序列。
 * `data: [DONE]` 与非法 JSON 行安全跳过。
 */
export async function* parseOpenAIStream(
  openaiStream: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAIStreamChunk, void> {
  const reader = openaiStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return

        let chunk: OpenAIStreamChunk
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        yield chunk
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 把 Anthropic 流式事件序列化为 SSE 字节。
 * JSON.stringify 会把内容里的换行转义为 `\n`，因此 data 行不会包含原始换行字节。
 */
export function serializeAnthropicStreamEvent(
  event: AnthropicStreamEvent,
): Uint8Array {
  const encoder = new TextEncoder()
  return encoder.encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * 将 OpenAI 兼容的 SSE 流转换为 Anthropic Messages 流式事件 SSE 流。
 *
 * 修复点（相对旧内联实现）：
 * - message_start 在首个 chunk 时发送（客户端在 content_block_stop 时要求 partialMessage 非空）
 * - thinking 块生命周期正确（reasoning_content 到来时打开，text/tool/finish 时关闭）
 * - 空 reasoning_content 也生成 thinking 块（DeepSeek 往返要求）
 * - usage 归一化并在流末 message_delta 一次性下发（含 trailing usage chunk）
 * - tool 参数增量以 input_json_delta 转发（否则客户端 tool_use.input 永远为空）
 */
export function convertOpenAIStreamToAnthropic(
  openaiStream: ReadableStream<Uint8Array>,
  model: string,
  options?: { includeCacheWriteTokens?: boolean },
): ReadableStream<Uint8Array> {
  const events = adaptOpenAIStreamToAnthropic(
    parseOpenAIStream(openaiStream),
    model,
    options,
  )

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(serializeAnthropicStreamEvent(event))
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      // 上游 ReadableStream 由 parseOpenAIStream 的 reader 负责释放；
      // 此处仅兜底取消，避免中止请求时泄漏。
    },
  })
}