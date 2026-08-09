/**
 * OpenAI Chat Completions 非流式响应 → Anthropic Messages API 响应。
 */

export type OpenAIResponseShape = {
  id?: string
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id: string
        function: { name: string; arguments: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * 将 OpenAI 非流式响应转换为 Anthropic Messages 格式
 * （含 thinking/reasoning 与 tool_use）。
 */
export function convertOpenAIResponseToAnthropic(
  data: OpenAIResponseShape,
  model: string,
  idPrefix: string,
): Record<string, unknown> {
  const choice = data.choices?.[0]
  const anthropicContent: Array<{
    type: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: unknown
  }> = []

  if (choice?.message?.reasoning_content) {
    anthropicContent.push({
      type: 'thinking',
      thinking: choice.message.reasoning_content,
    })
  }

  if (choice?.message?.content) {
    anthropicContent.push({ type: 'text', text: choice.message.content })
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: unknown = {}
      try {
        input = JSON.parse(tc.function.arguments || '{}')
      } catch {
        // 参数不是合法 JSON 时退化为空对象，避免整个响应解析失败
      }
      anthropicContent.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  return {
    id: data.id || `msg_${idPrefix}_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: anthropicContent,
    model,
    stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  }
}