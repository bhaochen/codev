/**
 * ModelRuntime — LLM 调用编排层，薄封装 Route + Model + Client。
 * 不含 Provider 分支、Auth、Transport 细节；Client 按 Protocol 共享。
 * Runtime 边界是 provider-neutral 的 LLMRequest（config + context）；各
 * Client 自行把 request 适配到自己的 wire boundary。
 *
 * Supports optional ComboConfig for multi-model cascade fallback.
 * When combo is provided, ComboEngine handles candidate selection and
 * cross-model fallback with safe streaming semantics.
 */
import { resolveRoute } from '../router/resolveRoute.js'
import { getModelMetadata } from '../models/registry.js'
import { getClientForRoute } from '../clients/index.js'
import { ComboEngine } from './ComboEngine.js'
import type { ComboConfig, ComboEvent } from './ComboEngine.js'
import type { LLMRequest } from './types.js'

export class ModelRuntime {
  private _comboEngine: ComboEngine | null = null

  private get comboEngine(): ComboEngine {
    if (!this._comboEngine) {
      this._comboEngine = new ComboEngine()
    }
    return this._comboEngine
  }

  /**
   * Generate with single-model routing (default behavior).
   */
  async *generate(request: LLMRequest) {
    const route = resolveRoute({
      model: request.model,
      provider: request.context.providerOverride,
    })
    const modelMeta = getModelMetadata(route.model)
    const client = getClientForRoute(route)
    if (!client) {
      throw new Error(`No client for protocol ${route.protocol}`)
    }
    yield* client.query(route, request)
    void modelMeta // 预留：capabilities 可用于后续限流/重试决策，不进入 Route
  }

  /**
   * Generate with combo cascade fallback.
   * 
   * Safety: ComboEngine enforces that once content events are emitted,
   * no transparent model switch occurs. Pre-stream failures can fallback.
   */
  async *generateWithCombo(
    request: LLMRequest,
    combo: ComboConfig,
    onEvent?: (event: ComboEvent) => void,
  ) {
    yield* this.comboEngine.generate(request, combo, onEvent)
  }
}

// Lazy singleton to avoid circular dependency issues
let _modelRuntime: ModelRuntime | null = null
export function getModelRuntime(): ModelRuntime {
  if (!_modelRuntime) {
    _modelRuntime = new ModelRuntime()
  }
  return _modelRuntime
}

/** @deprecated Use getModelRuntime() instead */
export const modelRuntime = getModelRuntime()
