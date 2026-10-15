/**
 * OpenCode Provider Adapter — matches zen-free plugin implementation.
 *
 * Key behaviors (matching magpie's zen-free plugin):
 * - Base URL: https://opencode.ai/inference/v1 (not zen/v1)
 * - Per-protocol User-Agent with correct provider-utils version
 * - Stable session ID per conversation (validated counter < 16)
 * - Injects 5 CORE_TOOLS (bash, edit, glob, grep, read) with parameters
 * - Forces stream=true for all requests
 * - Forces redirect: "error" to prevent redirects
 * - Real tool schemas with proper parameters
 */
import type { ProviderAdapter } from './ProviderAdapter.js'
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { Credential } from '../auth/strategies.js'
import { getOpenCodeApiKey } from '../../../utils/auth.js'
import { getOpencodeModelMaxTokens } from '../../../utils/model/opencodeModels.js'
import {
  getOpencodeUserAgent,
  getInferenceBaseUrl,
  getSessionIdForRequest,
  normalizeToolsForZen,
  buildOpencodeHeaders,
  CORE_TOOLS,
} from '../../../services/api/opencodeUserAgent.js'
import { logForDebugging } from '../../../utils/debug.js'

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = 'opencode' as const

  resolveAuth(): Credential {
    const key = getOpenCodeApiKey()
    if (key) {
      return { type: 'bearer', token: key }
    }
    // OpenCode free tier: use 'public' token
    return { type: 'bearer', token: 'public' }
  }

  /**
   * Get endpoint URL — always uses inference/v1 for free tier.
   */
  getEndpoint(route: LLMRoute, request: LLMRequest): string {
    const baseUrl = route.endpoint ?? 'https://opencode.ai/zen/v1/chat/completions'
    return getInferenceBaseUrl(baseUrl)
  }

  buildHeaders(route: LLMRoute, request: LLMRequest): Record<string, string> {
    // Determine protocol from route
    const protocol = route.protocol === 'openai-responses' ? 'responses'
      : route.protocol === 'anthropic-messages' ? 'anthropic'
      : 'chat'

    // Build minimal headers object for session ID extraction
    const tempHeaders = new Headers()
    const body = { model: request.model, messages: request.messages }

    const h = buildOpencodeHeaders(protocol, tempHeaders, body)

    // Convert to plain object
    const headers: Record<string, string> = {}
    h.forEach((value, key) => { headers[key] = value })

    // Free tier always requires streaming
    if (this.isFreeModel(request.model)) {
      headers.Accept = 'text/event-stream'
    }

    logForDebugging('[OpenCodeAdapter] Using inference API with proper headers for free tier')
    return headers
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
    route: LLMRoute,
    request: LLMRequest,
  ): Record<string, string | boolean | object> {
    // Determine protocol
    const protocol = route.protocol === 'openai-responses' ? 'responses'
      : route.protocol === 'anthropic-messages' ? 'anthropic'
      : 'chat'

    // Free tier: always stream
    if (this.isFreeModel(request.model)) {
      body.stream = true
    }

    // Inject CORE_TOOLS (bash, edit, glob, grep, read) with proper schemas
    if (this.isFreeModel(request.model) && Array.isArray(body.tools)) {
      const { declared } = normalizeToolsForZen(body, protocol)

      logForDebugging(`[OpenCodeAdapter] Injected tools, declared: ${[...declared].join(', ')}`)
    }

    return body
  }

  isFreeModel(model: string): boolean {
    return model.includes('free') || model.includes('contributor')
  }

  classifyError(error: unknown): import('./ProviderAdapter.js').ProviderErrorClass {
    const status = (error as { status?: number })?.status
    const text = String(error)

    // FreeTierError is permanent for third-party clients
    if (status === 403 || text.includes('FreeTierError') || text.includes('free tier can only be used from within OpenCode')) {
      return 'auth'
    }
    if (status === 429) return 'rate_limit'
    if (status === 500) return 'capacity'
    if (status && status >= 500) return 'server_error'
    if (status === 401) return 'auth'
    return 'unknown'
  }
}

export { CORE_TOOLS }