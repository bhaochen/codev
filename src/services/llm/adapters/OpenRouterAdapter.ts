/**
 * OpenRouter Provider Adapter.
 *
 * OpenRouter-specific behavior:
 * - HTTP-Referer and X-Title headers for attribution
 * - Tool freezing for prefix cache stability
 * - Gemini cache anchoring for Gemini models
 * - reasoning_details support for multi-turn reasoning continuity
 * - Free model fallback on 500 errors
 */
import type { ProviderAdapter } from './ProviderAdapter.js'
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { Credential } from '../auth/strategies.js'
import { getOpenRouterApiKey } from '../../../utils/auth.js'
import { isGeminiOnOpenRouter } from '../protocols/openrouterGeminiCache.js'

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = 'openrouter' as const

  resolveAuth(): Credential {
    const key = getOpenRouterApiKey()
    if (key) {
      return { type: 'bearer', token: key }
    }
    return { type: 'none' }
  }

  buildHeaders(_route: LLMRoute, _request: LLMRequest): Record<string, string> {
    return {
      'HTTP-Referer': 'https://opencode.ai/',
      'X-Title': 'codev',
    }
  }

  supportsCapability(capability: 'reasoning_details' | 'prompt_cache', model: string): boolean {
    switch (capability) {
      case 'reasoning_details':
        return true  // OpenRouter returns typed reasoning state
      case 'prompt_cache':
        return isGeminiOnOpenRouter(model)
      default:
        return false
    }
  }

  isFreeModel(model: string): boolean {
    return model.includes('free') || model.includes(':free')
  }

  classifyError(error: unknown): import('./ProviderAdapter.js').ProviderErrorClass {
    const status = (error as { status?: number })?.status
    if (status === 429) return 'rate_limit'
    if (status === 500) return 'capacity'  // OpenRouter 500 on free models → fallback
    if (status && status >= 500) return 'server_error'
    if (status === 401 || status === 403) return 'auth'
    return 'unknown'
  }
}
