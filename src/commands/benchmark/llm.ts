/**
 * /benchmark —— 统一 LLM 调用入口。
 *
 * 走 codev 的一等 query 管线（queryWithModel）——Anthropic / OpenAI /
 * ChatGPT 订阅等 provider 都能用，usage 也能拿实测值。
 * 每次调用是「system + 单条 user（完整 transcript）」的非流式文本补全，
 * 与 OpenSeeker/ABSeeker 的文本式 ReAct（<tool_call>/<answer>）一致。
 */
import {
  queryWithModel,
  type Options as QueryModelOptions,
} from '../../services/api/claude.js'
import { extractTextContent } from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

/** queryWithModel 的 options（Omit<Options,'getToolPermissionContext'> 同构） */
type LlmOptions = Omit<QueryModelOptions, 'getToolPermissionContext'>

export type LlmCallResult = {
  text: string
  tokensIn: number
  tokensOut: number
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 180_000

/**
 * 单轮文本补全。失败时抛错，由上层决定重试/结束。
 */
export async function llmComplete(
  systemPrompt: string,
  transcript: string,
  opts: {
    model?: string
    maxTokens?: number
    timeoutMs?: number
  } = {},
): Promise<LlmCallResult> {
  const {
    model = getMainLoopModel(),
    maxTokens = 4096,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const result = await queryWithModel({
      systemPrompt: asSystemPrompt([systemPrompt]),
      userPrompt: transcript,
      signal: controller.signal,
      options: {
        model,
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: maxTokens,
      } satisfies LlmOptions,
    })

    // 运行时是嵌套 shape：result.message.content / result.message.usage
    const inner = result as unknown as {
      message: {
        content: Parameters<typeof extractTextContent>[0]
        usage?: { input_tokens?: number; output_tokens?: number }
      }
    }
    const text = extractTextContent(inner.message.content)

    return {
      text,
      tokensIn: inner.message.usage?.input_tokens ?? 0,
      tokensOut: inner.message.usage?.output_tokens ?? 0,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 注：OpenAI 兼容端点（如 DeepSeek 免费档）可能在无 finish_reason 时掐流。
 * 被截断的文本缺少完整 <tool_call>/<answer>，由 agent 的解析层按 malformed
 * 处理（不会静默当作完整 turn 结束）。
 */