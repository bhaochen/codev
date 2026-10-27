/**
 * Route 仅组合 Provider+Model+Protocol+endpoint 为一次可执行请求，
 * 不负责 Auth / Capability / Transport 生命周期。
 * Phase 4: Provider 降为默认 fallback,Route 为具体调用方案,支持 protocol/endpoint 显式覆盖。
 */
import type { LLMRoute } from '../types.js'
import { getProviderDef } from '../providers/index.js'
import { resolveModel } from './resolveModel.js'
import { buildRoute, normalizeRouteInput, type RouteInput } from '../route/Route.js'
import { getAPIProvider } from '../../../utils/model/providers.js'

export type ResolveRouteInput = RouteInput

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
  const defaultEndpoint = def.defaultEndpoint ?? def.endpoint
  return buildRoute({
    provider,
    model,
    protocol: defaultProtocol,
    endpoint: defaultEndpoint,
  })
}
