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
  const { rawModel, overrideProvider, overrideProtocol, overrideEndpoint } = normalizeRouteInput(input)
  // Provider selection: an explicit route-level override wins; otherwise
  // custom endpoint beats the 9router gateway.
  const provider = overrideProvider ?? (getAPIProvider() ?? 'openai')
  const def = getProviderDef(provider) as {
    defaultProtocol?: LLMRoute['protocol']
    protocol?: LLMRoute['protocol']
    defaultEndpoint?: string
    endpoint?: string
  } | undefined
  if (!def) {
    // Legacy provider pin (nvidia/anthropic/bedrock/…): the runtime is now
    // unified on OpenAI-compatible endpoints, so there is no per-provider
    // definition. Fail loudly instead of crashing with a TypeError.
    throw new Error(
      `Provider '${provider}' has no route definition. codev routes through unified OpenAI-compatible endpoints — configure one in /login or use provider 'openai' (gateway) / 'custom' (endpoint).`,
    )
  }
  const model = resolveModel(provider, rawModel)
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
    overrideProtocol,
    overrideEndpoint,
  })
}
