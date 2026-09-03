/**
 * Route 仅组合 Provider+Model+Protocol+endpoint 为一次可执行请求，
 * 不负责 Auth / Capability / Transport 生命周期。
 * Phase 4: Provider 降为默认 fallback,Route 为具体调用方案,支持 protocol/endpoint 显式覆盖。
 */
import type { LLMRoute } from '../types.js'
import { getProviderDef } from '../providers/index.js'
import { resolveProviderContext } from './resolveProvider.js'
import { resolveModel } from './resolveModel.js'
import { buildRoute, normalizeRouteInput, type RouteInput } from '../route/Route.js'

export type ResolveRouteInput = RouteInput

export function resolveRoute(input: ResolveRouteInput): LLMRoute {
  const { rawModel, overrideProtocol, overrideEndpoint } = normalizeRouteInput(input)
  const { provider } = resolveProviderContext()
  const model = resolveModel(provider, rawModel)
  const def = getProviderDef(provider) as { protocol: LLMRoute['protocol']; endpoint?: string }
  // ProviderDef.protocol 仍为默认 fallback,显式 override 优先
  return buildRoute({
    provider,
    model,
    protocol: def.protocol,
    endpoint: def.endpoint,
    overrideProtocol,
    overrideEndpoint,
  })
}
