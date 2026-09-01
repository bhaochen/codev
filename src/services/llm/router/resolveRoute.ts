/**
 * Route 仅组合 Provider+Model+Protocol+endpoint 为一次可执行请求，
 * 不负责 Auth / Capability / Transport 生命周期。
 * Protocol 为 Provider 静态属性，不单独 resolver。
 */
import type { LLMRoute } from '../types.js'
import { getProviderDef } from '../providers/index.js'
import { resolveProviderContext } from './resolveProvider.js'
import { resolveModel } from './resolveModel.js'

export function resolveRoute(fallbackModel: string): LLMRoute {
  const { provider } = resolveProviderContext()
  const model = resolveModel(provider, fallbackModel)
  const def = getProviderDef(provider) as { protocol: LLMRoute['protocol']; endpoint?: string }
  const protocol = def.protocol
  const endpoint = def.endpoint
  return { provider, protocol, model, endpoint }
}
