import type { ProviderId, ProtocolId } from '../types.js'
import { getOpenRouterBaseUrl } from '../../../utils/model/providers.js'

// OpenRouter 的 OpenAI 兼容路由是 {base}/v1/chat/completions；getOpenRouterBaseUrl
// 已把 openrouter.ai 规范到 /api，但自定义 OPENROUTER_BASE_URL 可能自带 /v1。
function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/$/, '')
  return b.endsWith('/v1') ? `${b}/chat/completions` : `${b}/v1/chat/completions`
}

export const openrouter = {
  id: 'openrouter' as ProviderId,
  defaultProtocol: 'openai-chat' as ProtocolId,
  get defaultEndpoint(): string { return chatCompletionsUrl(getOpenRouterBaseUrl()) },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return fallback },
} as const
