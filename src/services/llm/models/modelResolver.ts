/**
 * Model Resolver — Phase 10: independent boundary.
 * Provider is no longer the sole authority for model resolution.
 * ProviderDef may still expose resolveModel as compatibility alias,
 * but runtime goes through this module.
 */
import type { ProviderId } from '../types.js'
import { getOpenCodeModelName } from '../../../utils/auth.js'
import { getCustomApiConfig } from '../../../utils/auth.js'
import { resolveOpenAIModel } from '../utils/modelMapping.js'
import { getUserSpecifiedModelSetting } from '../../../utils/model/model.js'

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
    // model = 用户通过 /model 显式选择的模型（如 big-pickle）
    // getOpenCodeModelName() = 登录时保存的默认值
    // 用户显式选择优先；只有 model 为空/null 时才用 config 默认值
    try {
      return model || getOpenCodeModelName() || 'big-pickle'
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

/**
 * Resolve the model for the custom (OpenAI-compatible) endpoint.
 *
 * An explicit user choice — ``--model``, ``/model``, or a model env var —
 * wins. Otherwise the model stored for that endpoint (``customModelName``
 * from ``/login``, or ``CODEV_MODEL``/``OPENAI_MODEL``) is used, and only
 * then the caller-provided default.
 */
export function resolveCustomModel(fallback: string): string {
  try {
    if (getUserSpecifiedModelSetting() !== undefined) return fallback
  } catch {
    // Fall through to the stored model.
  }
  try {
    const config = getCustomApiConfig()
    if (config.modelName) return config.modelName
  } catch {
    // Fall through to the fallback.
  }
  return fallback
}

const customResolver: ModelResolver = {
  id: 'custom',
  resolve(_provider, model) {
    return resolveCustomModel(model)
  },
}

const resolverByProvider: Partial<Record<ProviderId, ModelResolver>> = {
  openai: openAIResolver,
  opencode: openCodeResolver,
  custom: customResolver,
}

export function getModelResolver(provider: ProviderId): ModelResolver {
  return resolverByProvider[provider] ?? passthroughResolver
}

export function resolveModel(provider: ProviderId, fallback: string): string {
  return getModelResolver(provider).resolve(provider, fallback)
}
