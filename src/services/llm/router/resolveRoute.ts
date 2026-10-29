/**
 * Route 仅组合 Provider+Model+Protocol+endpoint 为一次可执行请求，
 * 不负责 Auth / Capability / Transport 生命周期。
 * Phase 4: Provider 降为默认 fallback,Route 为具体调用方案,支持 protocol/endpoint 显式覆盖。
 */
import type { LLMRoute } from '../types.js'
import { getProviderDef } from '../providers/index.js'
import { resolveModel } from './resolveModel.js'
import { buildRoute, normalizeRouteInput, type RouteInput } from '../route/Route.js'
import { getAPIProvider, getChatCompletionsUrl } from '../../../utils/model/providers.js'

export type ResolveRouteInput = RouteInput

/**
 * Route a custom-provider request to the enabled endpoint that actually
 * serves the selected model. Several endpoints may be enabled at once
 * (/login Enter toggles them), and /model lists models from all of them —
 * so a model picked from endpoint B must be sent to endpoint B, not to the
 * primary endpoint. Falls back to the primary endpoint when the model is
 * not in the cache (e.g. it was typed via /model <name> before a fetch).
 */
function resolveCustomEndpointForModel(model: string): string | undefined {
  try {
    // Lazy require: customModels imports this module's package (providers),
    // and a static import would create a cycle.
    const { getCachedCustomModels } = require('../../../utils/model/customModels.js') as {
      getCachedCustomModels: () => Array<{ id: string; baseUrl: string }>
    }
    const hit = getCachedCustomModels().find(m => m.id === model)
    if (!hit) return undefined
    return getChatCompletionsUrl(hit.baseUrl)
  } catch {
    return undefined
  }
}

export function resolveRoute(input: ResolveRouteInput): LLMRoute {
  const { rawModel } = normalizeRouteInput(input)
  // Provider selection: custom endpoint takes precedence over 9router.
  const provider = getAPIProvider() ?? 'openai'
  const model = resolveModel(provider, rawModel)
  const def = getProviderDef(provider) as {
    defaultProtocol?: LLMRoute['protocol']
    protocol?: LLMRoute['protocol']
    defaultEndpoint?: string
    endpoint?: string
  }
  const defaultProtocol = def.defaultProtocol ?? def.protocol!
  let defaultEndpoint = def.defaultEndpoint ?? def.endpoint
  if (provider === 'custom') {
    defaultEndpoint = resolveCustomEndpointForModel(model) ?? defaultEndpoint
  }
  return buildRoute({
    provider,
    model,
    protocol: defaultProtocol,
    endpoint: defaultEndpoint,
  })
}
