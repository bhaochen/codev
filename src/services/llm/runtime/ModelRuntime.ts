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
      // Anthropic 系回退至原生 SDK 路径，由 claude.ts 兼容层处理；此处抛错由上层捕获走旧路径
      throw new Error(`No client for protocol ${route.protocol}`)
    }
    yield* client.query(route, input.messages, input.systemPrompt, input.tools, input.signal, input.options)
    void modelMeta // 预留：capabilities 可用于后续限流/重试决策，不进入 Route
  }
}

export const modelRuntime = new ModelRuntime()
