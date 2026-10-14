/**
 * OpenCode Provider Adapter.
 *
 * OpenCode-specific behavior:
 * - x-opencode-* headers for session tracking
 * - User-Agent: opencode
 * - Fingerprint tools for free tier
 * - Force stream=true for free models
 * - Model max tokens from catalog
 */
import type { ProviderAdapter } from './ProviderAdapter.js'
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { Credential } from '../auth/strategies.js'
import { getOpencodeApiKey } from '../../../utils/auth.js'
import { getOpencodeModelMaxTokens } from '../../../utils/model/opencodeModels.js'

const FINGERPRINT_TOOLS = [
  'fingerprint_20260301',
  'fingerprint_20260302',
]

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = 'opencode' as const

  resolveAuth(): Credential {
    const key = getOpencodeApiKey()
    if (key) {
      return { type: 'bearer', token: key }
    }
    // OpenCode free tier: use 'public' token
    return { type: 'bearer', token: 'public' }
  }

  buildHeaders(_route: LLMRoute, _request: LLMRequest): Record<string, string> {
    return {
      'User-Agent': 'opencode',
      'x-opencode-client': 'desktop',
      'x-opencode-project': 'global',
      'x-opencode-session': 'session-placeholder',
      'x-opencode-request': crypto.randomUUID(),
    }
  }

  supportsCapability(capability: 'reasoning_details' | 'prompt_cache'): boolean {
    return false
  }

  getMaxOutputTokens(model: string): number | undefined {
    try {
      return getOpencodeModelMaxTokens(model)
    } catch {
      return undefined
    }
  }

  transformRequestBody(
    body: Record<string, string | boolean | object>,
    _route: LLMRoute,
    request: LLMRequest,
  ): Record<string, string | boolean | object> {
    // Free tier: force stream=true, backend SSE only (#4132)
    if (this.isFreeModel(request.model)) {
      body.stream = true
    }
    return body
  }

  isFreeModel(model: string): boolean {
    return model.includes('free') || model.includes('contributor')
  }

  classifyError(error: unknown): import('./ProviderAdapter.js').ProviderErrorClass {
    const status = (error as { status?: number })?.status
    if (status === 429) return 'rate_limit'
    if (status === 500) return 'capacity'  // Free tier 500 → fallback to big-pickle
    if (status && status >= 500) return 'server_error'
    if (status === 401 || status === 403) return 'auth'
    return 'unknown'
  }
}

export { FINGERPRINT_TOOLS }
