/**
 * 共享协议形状：内部 Anthropic 消息 ↔ OpenAI Chat Completions 消息。
 *
 * 这些类型被 src/services/api/openai、opencodeClient、nvidiaClient 共用，
 * 保持与既有转换管线完全一致的形状（避免破坏现有调用点）。
 */

/** OpenAI Chat Completions 消息（转换管线的产物 / 请求体输入）。 */
export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>
    | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  /**
   * DeepSeek 等推理模型要求把上一轮的 reasoning_content 原样传回，
   * 否则下一轮请求会 400。因此助手消息允许透传（含空字符串）。
   */
  reasoning_content?: string
}

/** OpenAI Chat Completions tool 定义。 */
export type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** OpenAI 流式 chunk 的简化形状（SSE `data:` 行 JSON 解析产物）。 */
export type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
      role?: string
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
    }
  }
}

/** Anthropic Messages API 内容块（SDK BetaMessage.content 的简化形状）。 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | { type: 'tool_result'; tool_use_id: string; content: unknown }
  | { type: 'thinking'; thinking: string }
  | Record<string, unknown>

/** Anthropic Messages API 消息（fetch override 从请求体解析出的形状）。 */
export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}