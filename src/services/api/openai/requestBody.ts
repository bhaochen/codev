/**
 * OpenAI 请求体构造与 thinking 模式检测（纯函数，无模块副作用）。
 */
import type { OpenAIMessage, OpenAITool } from '@ant/model-provider'
import { isEnvTruthy, isEnvDefinedFalsy } from '../../../utils/envUtils.js'

/**
 * 检测该模型是否启用 thinking 模式。
 *
 * 启用条件：
 * 1. OPENAI_ENABLE_THINKING=1 显式启用，或
 * 2. 模型名包含 "deepseek" 或 "mimo"（自动检测，大小写不敏感）
 *
 * 禁用条件：
 * - OPENAI_ENABLE_THINKING=0/false/no/off 显式禁用（优先级最高，覆盖模型检测）
 *
 * Grok 有意排除：Grok 推理模型自动推理，不需要 thinking/enable_thinking 请求参数。
 */
export function isOpenAIThinkingEnabled(model: string): boolean {
  // 显式禁用优先
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return false
  // 显式启用
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return true
  // 从模型名自动检测（DeepSeek 与 MiMo 支持 thinking 模式）
  const modelLower = model.toLowerCase()
  return modelLower.includes('deepseek') || modelLower.includes('mimo')
}

/**
 * 解析 OpenAI 兼容路径的最大输出 token。
 *
 * 优先级：
 * 1. maxOutputTokensOverride（程序化，来自 query 管线）
 * 2. OPENAI_MAX_TOKENS env（OpenAI 专用，适用于本地小上下文模型）
 * 3. CLAUDE_CODE_MAX_OUTPUT_TOKENS env（通用覆盖）
 * 4. upperLimit 默认值
 */
export function resolveOpenAIMaxTokens(
  upperLimit: number,
  maxOutputTokensOverride?: number,
): number {
  return (
    maxOutputTokensOverride ??
    (process.env.OPENAI_MAX_TOKENS
      ? parseInt(process.env.OPENAI_MAX_TOKENS, 10) || undefined
      : undefined) ??
    (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 10) || undefined
      : undefined) ??
    upperLimit
  )
}

export type OpenAIRequestBody = Record<string, unknown> & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
  prompt_cache_key?: string
}

/**
 * 构造 OpenAI chat.completions 请求体。thinking 模式注入三套格式，
 * 每个端点识别其中自己认识的那套，其余忽略：
 * - 官方 DeepSeek API:    `thinking: { type: 'enabled' }`
 * - 自托管 DeepSeek:      `enable_thinking: true` + `chat_template_kwargs: { thinking: true }`
 * - MiMo (小米):          `chat_template_kwargs: { enable_thinking: true }`
 * HTTP 层对未知键透传，无兼容性问题。
 */
export function buildOpenAIRequestBody(params: {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  toolChoice?: unknown
  enableThinking: boolean
  maxTokens: number
  temperatureOverride?: number
  /** OpenAI 官方端点的会话级 prompt-cache 路由键。 */
  promptCacheKey?: string
}): OpenAIRequestBody {
  const {
    model,
    messages,
    tools,
    toolChoice,
    enableThinking,
    maxTokens,
    temperatureOverride,
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
    // DeepSeek / MiMo 的思维链输出；启用后温度 etc. 被端点忽略
    ...(enableThinking && {
      thinking: { type: 'enabled' },
      enable_thinking: true,
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }),
    // 仅 thinking 关闭时发送 temperature（DeepSeek 不看，但其他 provider 可能看）
    ...(!enableThinking &&
      temperatureOverride !== undefined && {
        temperature: temperatureOverride,
      }),
  }
}