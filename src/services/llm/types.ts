/**
 * LLM 最小路由类型 — Provider 决定谁，Model 决定哪个，Protocol 决定怎么说，Client 执行。
 * Auth/Capabilities 不进 Route，Transport 降为 Client 内部实现。
 */
export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'opencode'
  | 'nvidia'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'local'

export type ProtocolId =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses'

export type LLMRoute = {
  provider: ProviderId
  protocol: ProtocolId
  model: string
  endpoint?: string
}

export type ProviderContext = {
  provider: ProviderId
  source: 'env' | 'sdk-flag' | 'config' | 'default'
}

export type ClientId = ProtocolId
