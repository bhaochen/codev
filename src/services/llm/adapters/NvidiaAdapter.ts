/**
 * NVIDIA Provider Adapter.
 *
 * NVIDIA-specific behavior:
 * - HTTP-Referer and X-Title headers (NVIDIA NIM requirement)
 * - prompt_cache_key omitted (NVIDIA rejects OpenAI's extension)
 * - enable_thinking/thinking fields rejected for most models
 * - X-BILLING-INVOKE-ORIGIN header
 */
import type { ProviderAdapter } from './ProviderAdapter.js'
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { Credential } from '../auth/strategies.js'
import { getNvidiaApiKey } from '../../../utils/auth.js'

export class NvidiaAdapter implements ProviderAdapter {
  readonly id = 'nvidia' as const

  resolveAuth(): Credential {
    const key = getNvidiaApiKey()
    if (key) {
      return { type: 'bearer', token: key }
    }
    return { type: 'none' }
  }

  buildHeaders(_route: LLMRoute, _request: LLMRequest): Record<string, string> {
    return {
      'HTTP-Referer': 'https://opencode.ai/',
      'X-Title': 'codev',
      'X-BILLING-INVOKE-ORIGIN': 'OpenCode',
    }
  }

  supportsCapability(capability: 'reasoning_details' | 'prompt_cache' | 'reasoning'): boolean {
    // NVIDIA doesn't support these OpenAI extensions
    return false
  }

  getMaxOutputTokens(model: string): number | undefined {
    // Import from catalog
    try {
      const { getNvidiaModelMaxTokens } = require('../../../utils/model/nvidiaModels.js')
      return getNvidiaModelMaxTokens(model)
    } catch {
      return undefined
    }
  }

  isFreeModel(_model: string): boolean {
    return true  // NVIDIA NIM free tier
  }

  classifyError(error: unknown): import('./ProviderAdapter.js').ProviderErrorClass {
    const status = (error as { status?: number })?.status
    if (status === 429) return 'rate_limit'
    if (status && status >= 500) return 'capacity'
    if (status === 401 || status === 403) return 'auth'
    return 'unknown'
  }
}
