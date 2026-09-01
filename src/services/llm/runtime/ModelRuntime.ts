/**
 * ModelRuntime — LLM 调用编排层，薄封装 Route + Model + Client。
 * 不含 Provider 分支、Auth、Transport 细节；Client 按 Protocol 共享。
 */
import { resolveRoute } from '../router/resolveRoute.js'
import { getModelMetadata } from '../models/registry.js'
import { getClientForRoute } from '../clients/index.js'
import type { ModelRequest } from './types.js'

export class ModelRuntime {
  async *generate(input: ModelRequest) {
    const route = resolveRoute(input.model)
    const modelMeta = getModelMetadata(route.model)
    const client = getClientForRoute(route)
    if (!client) {
      throw new Error(`No client for protocol ${route.protocol}`)
    }
    // AnthropicMessages 需要 thinkingConfig，经 Options 透传以保持 Client 签名统一（Protocol 客户端不分支 provider）
    const optionsWithThinking = input.thinkingConfig
      ? ({ ...input.options, thinkingConfig: input.thinkingConfig } as unknown as typeof input.options)
      : input.options
    yield* client.query(route, input.messages, input.systemPrompt, input.tools, input.signal, optionsWithThinking)
    void modelMeta // 预留：capabilities 可用于后续限流/重试决策，不进入 Route
  }
}

export const modelRuntime = new ModelRuntime()
