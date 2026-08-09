/**
 * OpenAI usage → Anthropic usage 归一化，以及 count_tokens 的本地 token 估算。
 */

/** Anthropic 四个互斥的 usage 字段。 */
export type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/**
 * 把 OpenAI 的总输入 usage 拆成 Anthropic 的互斥字段。
 * cache read 优先，当供应商数据畸形（字段重叠）时避免负值。
 */
export function normalizeOpenAIUsage(params: {
  totalInputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): AnthropicUsage {
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

/**
 * 从 Anthropic 请求体估算 input tokens（chars/4，图片/文档按 2000 计，
 * 与 tokenEstimation.ts 的 roughTokenCountEstimationForBlock 保持一致）。
 * 用于替代 count_tokens stub 的 0 —— 0 会让 codev 的上下文预算/compact 全部失效。
 */
export function estimateTokensForAnthropicBody(body: {
  system?: unknown
  messages?: unknown
  tools?: unknown
}): number {
  let total = 0
  const roughCount = (text: string): number => Math.round(text.length / 4)

  if (typeof body.system === 'string') {
    total += roughCount(body.system)
  } else if (Array.isArray(body.system)) {
    for (const b of body.system) {
      if (
        b &&
        typeof b === 'object' &&
        typeof (b as { text?: unknown }).text === 'string'
      ) {
        total += roughCount((b as { text: string }).text)
      }
    }
  }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue
      const tool = t as {
        name?: unknown
        description?: unknown
        input_schema?: unknown
      }
      if (typeof tool.name === 'string') total += roughCount(tool.name)
      if (typeof tool.description === 'string') {
        total += roughCount(tool.description)
      }
      if (tool.input_schema !== undefined) {
        total += roughCount(JSON.stringify(tool.input_schema))
      }
    }
  }

  const countBlocks = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const b = block as {
        type?: unknown
        text?: unknown
        thinking?: unknown
        data?: unknown
        name?: unknown
        input?: unknown
        content?: unknown
      }
      switch (b.type) {
        case 'text':
          total += roughCount(typeof b.text === 'string' ? b.text : '')
          break
        case 'thinking':
          total += roughCount(typeof b.thinking === 'string' ? b.thinking : '')
          break
        case 'redacted_thinking':
          total += roughCount(typeof b.data === 'string' ? b.data : '')
          break
        case 'image':
        case 'document':
          total += 2000
          break
        case 'tool_use':
          total += roughCount(
            (typeof b.name === 'string' ? b.name : '') +
              JSON.stringify(b.input ?? {}),
          )
          break
        case 'tool_result':
          if (typeof b.content === 'string') {
            total += roughCount(b.content)
          } else if (Array.isArray(b.content)) {
            for (const c of b.content) {
              if (typeof c === 'string') {
                total += roughCount(c)
              } else if (c && typeof c === 'object') {
                const cc = c as { type?: unknown; text?: unknown; data?: unknown }
                if (cc.type === 'image' || cc.type === 'document') {
                  total += 2000
                } else if (typeof cc.text === 'string') {
                  total += roughCount(cc.text)
                }
              }
            }
          }
          break
        default:
          total += roughCount(JSON.stringify(b))
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue
      const m = msg as { content?: unknown }
      if (typeof m.content === 'string') {
        total += roughCount(m.content)
      } else {
        countBlocks(m.content)
      }
    }
  }

  return total
}