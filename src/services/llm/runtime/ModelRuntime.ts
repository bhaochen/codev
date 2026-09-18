/**
 * ModelRuntime — LLM 调用编排层，薄封装 Route + Model + Client。
 * 不含 Provider 分支、Auth、Transport 细节；Client 按 Protocol 共享。
 * Runtime 边界是 provider-neutral 的 LLMRequest（config + context）；各
 * Client 自行把 request 适配到自己的 wire boundary。
 */
import { resolveRoute } from '../router/resolveRoute.js'
import { getModelMetadata } from '../models/registry.js'
import { getClientForRoute } from '../clients/index.js'
import type { LLMRequest } from './types.js'

export class ModelRuntime {
  async *generate(request: LLMRequest) {
    const route = resolveRoute(request.model)
    const modelMeta = getModelMetadata(route.model)
    const client = getClientForRoute(route)
    if (!client) {
      throw new Error(`No client for protocol ${route.protocol}`)
    }
    yield* client.query(route, request)
    void modelMeta // 预留：capabilities 可用于后续限流/重试决策，不进入 Route
  }
}

export const modelRuntime = new ModelRuntime()
