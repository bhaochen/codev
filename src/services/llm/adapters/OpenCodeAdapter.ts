/**
 * OpenCode Provider Adapter.
 *
 * OpenCode-specific behavior (matching magpie's implementation):
 * - URL rewrite: /zen/v1 → /inference/v1 for free tier (since mid-Oct 2026)
 * - Precise headers matching OpenCode 1.19.0
 * - Real tool schemas (bash + read with parameters)
 * - Session ID with counter validation (low 12 bits < 16)
 * - Force stream=true for free models
 * - User-Agent matching real OpenCode 1.19.0
 */
import type { ProviderAdapter } from './ProviderAdapter.js'
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { Credential } from '../auth/strategies.js'
import { getOpenCodeApiKey } from '../../../utils/auth.js'
import { getOpencodeModelMaxTokens } from '../../../utils/model/opencodeModels.js'
import {
  getOpencodeUserAgent,
  translateSessionId,
  createRequestId,
  isRealOpencodeSession,
  FINGERPRINT_TOOLS,
  OPENCODE_TOOL_SCHEMAS,
  rewriteOpencodeFreeUrl,
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

  buildHeaders(route: LLMRoute, request: LLMRequest): Record<string, string> {
    // Generate session ID with proper counter validation
    const sessionId = translateSessionId(request.context.model, 'codev')
    const requestId = createRequestId()

    const headers: Record<string, string> = {
      'User-Agent': getOpencodeUserAgent(),
      'x-opencode-client': 'cli',  // Zen expects "cli" for official client
      'x-opencode-project': 'global',
      'x-opencode-session': sessionId,
      'x-opencode-session-id': sessionId,  // Zen reads both
      'x-opencode-request': requestId,
    }

    // Free tier requires stream
    if (this.isFreeModel(request.model)) {
      headers.Accept = 'text/event-stream'
    }

    // Warn that free tier is likely blocked for third-party clients
    if (this.isFreeModel(request.model)) {
      logForDebugging('[OpenCodeAdapter] WARNING: OpenCode free tier is blocked for third-party clients (TLS fingerprinting/device attestation). Consider using NVIDIA/OpenRouter free tier instead.')
    }

    return headers
  }

  /**
   * Get the endpoint URL, rewriting /zen/v1 to /inference/v1 for free tier.
   */
  getEndpoint(route: LLMRoute, request: LLMRequest): string {
    const baseUrl = route.endpoint ?? 'https://opencode.ai/zen/v1/chat/completions'
    if (this.isFreeModel(request.model)) {
      return rewriteOpencodeFreeUrl(baseUrl)
    }
    return baseUrl
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
    // Free tier: force stream=true, backend SSE only
    if (this.isFreeModel(request.model)) {
      body.stream = true
    }

    // Inject real tool schemas for bash/read if missing
    if (this.isFreeModel(request.model) && Array.isArray(body.tools)) {
      const existingNames = new Set(
        body.tools.map((t: any) => t.function?.name ?? t.name ?? '').filter(Boolean),
      )
      for (const toolName of FINGERPRINT_TOOLS) {
        if (!existingNames.has(toolName)) {
          body.tools.push({
            type: 'function',
            function: {
              name: toolName,
              description: 'Not available in this session. Never call this tool.',
              parameters: JSON.parse(OPENCODE_TOOL_SCHEMAS[toolName]),
            },
          })
        }
      }
    }

    return body
  }

  isFreeModel(model: string): boolean {
    return model.includes('free') || model.includes('contributor')
  }

  classifyError(error: unknown): import('./ProviderAdapter.js').ProviderErrorClass {
    const status = (error as { status?: number })?.status
    if (status === 429) return 'rate_limit'
    if (status === 500) return 'capacity'
    if (status && status >= 500) return 'server_error'
    if (status === 401 || status === 403) {
      // Check if it's a FreeTierError (permanently blocked for third-party)
      const text = String(error)
      if (text.includes('FreeTierError') || text.includes('free tier can only be used from within OpenCode')) {
        return 'auth'  // Treat as auth error to prevent retries
      }
      return 'auth'
    }
    return 'unknown'
  }
}

export { FINGERPRINT_TOOLS, OPENCODE_TOOL_SCHEMAS }