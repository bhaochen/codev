/**
 * Route 仅组合 Provider+Model+Protocol+endpoint 为一次可执行请求，
 * 不负责 Auth / Capability / Transport 生命周期。
 */
import type { LLMRoute } from '../types.js'
import { getProviderDef } from '../providers/index.js'
import { resolveProviderContext } from './resolveProvider.js'
import { resolveModel } from './resolveModel.js'
import { resolveProtocol } from './resolveProtocol.js'

export function resolveRoute(fallbackModel: string): LLMRoute {
  const { provider } = resolveProviderContext()
  const model = resolveModel(provider, fallbackModel)
  const protocol = resolveProtocol(provider)
  const def = getProviderDef(provider) as { endpoint?: string }
  const endpoint = def.endpoint
  return { provider, protocol, model, endpoint }
}
