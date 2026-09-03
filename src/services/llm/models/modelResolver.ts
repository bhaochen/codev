/**
 * Model Resolver — Phase 10: independent boundary.
 * Provider is no longer the sole authority for model resolution.
 * ProviderDef may still expose resolveModel as compatibility alias,
 * but runtime goes through this module.
 */
import type { ProviderId } from '../types.js'
import { getOpenCodeModelName } from '../../../utils/auth.js'
import { resolveOpenAIModel } from '@ant/model-provider'

export interface ModelResolver {
  id: string
  resolve(provider: ProviderId, model: string): string
}

// Provider-specific resolvers — independent of ProviderDef
const openAIResolver: ModelResolver = {
  id: 'openai',
  resolve(_provider, model) {
    return resolveOpenAIModel(model)
  },
}

const openCodeResolver: ModelResolver = {
  id: 'opencode',
  resolve(_provider, model) {
    try {
      return getOpenCodeModelName() || model || 'big-pickle'
    } catch {
      return model || 'big-pickle'
    }
  },
}

const passthroughResolver: ModelResolver = {
  id: 'passthrough',
  resolve(_provider, model) {
    return model
  },
}

const resolverByProvider: Partial<Record<ProviderId, ModelResolver>> = {
  openai: openAIResolver,
  opencode: openCodeResolver,
}

export function getModelResolver(provider: ProviderId): ModelResolver {
  return resolverByProvider[provider] ?? passthroughResolver
}

export function resolveModel(provider: ProviderId, fallback: string): string {
  return getModelResolver(provider).resolve(provider, fallback)
}
