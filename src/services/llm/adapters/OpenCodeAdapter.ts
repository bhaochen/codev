/**
 * OpenCode Provider Adapter — matches 9router PR #4842 implementation.
 *
 * Key behaviors (matching 9router fix for OpenCode v2 free tier):
 * - Base URL: https://opencode.ai/inference/v1 (not zen/v1)
 * - User-Agent: opencode/latest/2.0.26/cli (v2 format)
 * - Session ID with counter pinned to 1 (small counter < 16)
 * - Headers: x-opencode-session, x-opencode-session-id, x-session-affinity, x-session-id
 * - NO x-opencode-request (upstream rejects it)
 * - Tools: read + shell with EXACT verbatim OpenCode 2.0.26 definitions
 * - Force stream=true for free tier
 * - Tool choice: "auto" for Responses, undefined for chat (never "none")
 * - Placeholder system note for injected tools
 */
import type { ProviderAdapter } from './ProviderAdapter.js'
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { Credential } from '../auth/strategies.js'
import { getOpenCodeApiKey } from '../../../utils/auth.js'
import { getOpencodeModelMaxTokens } from '../../../utils/model/opencodeModels.js'
import {
  getInferenceBaseUrl,
  getSessionIdForRequest,
  buildOpencodeHeaders,
  CORE_TOOLS,
  FINGERPRINT_TOOL_DEFINITIONS,
  normalizeToolsForZen,
  aliasHistoryToolCalls,
  restoreToolNames,
} from '../../../services/api/opencodeUserAgent.js'
import { logForDebugging } from '../../../utils/debug.js'

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = 'opencode' as const

  resolveAuth(): Credential {
    const key = getOpenCodeApiKey()
    if (key) {
      return { type: 'bearer', token: key }
    }
    return { type: 'bearer', token: 'public' }
  }

  getEndpoint(route: LLMRoute, request: LLMRequest): string {
    const baseUrl = route.endpoint ?? 'https://opencode.ai/inference/v1/chat/completions'
    return getInferenceBaseUrl(baseUrl)
  }

  buildHeaders(route: LLMRoute, request: LLMRequest): Record<string, string> {
    const protocol = route.protocol === 'openai-responses' ? 'responses'
      : route.protocol === 'anthropic-messages' ? 'anthropic'
      : 'chat'

    const tempHeaders = new Headers()
    const body = { model: request.model, messages: request.messages }
    const h = buildOpencodeHeaders(protocol, tempHeaders, body)

    const headers: Record<string, string> = {}
    h.forEach((value, key) => { headers[key] = value })

    if (this.isFreeModel(request.model)) {
      headers.Accept = 'text/event-stream'
    }

    logForDebugging('[OpenCodeAdapter] Using inference/v1 with v2 client fingerprint')
    return headers
  }

  supportsCapability(capability: 'reasoning_details' | 'prompt_cache'): boolean {
    return false
  }

  getMaxOutputTokens(model: string): number | undefined {
    try { return getOpencodeModelMaxTokens(model) } catch { return undefined }
  }

  transformRequestBody(
    body: Record<string, string | boolean | object>,
    route: LLMRoute,
    request: LLMRequest,
  ): Record<string, string | boolean | object> {
    const protocol = route.protocol === 'openai-responses' ? 'responses'
      : route.protocol === 'anthropic-messages' ? 'anthropic'
      : 'chat'

    if (this.isFreeModel(request.model)) {
      body.stream = true
    }

    // Inject read + shell with verbatim OpenCode definitions
    if (this.isFreeModel(request.model) && Array.isArray(body.tools)) {
      const { declared, appended, aliasMap } = normalizeToolsForZen(body, protocol)

      // Rename prior-turn calls to aliased tools so the model doesn't confuse them
      if (aliasMap.size > 0) {
        aliasHistoryToolCalls(body, aliasMap)
      }

      // Retarget tool_choice that points at an aliased tool
      if (aliasMap.size > 0 && body.tool_choice && typeof body.tool_choice === 'object') {
        const choice = body.tool_choice as Record<string, unknown>
        const fn = choice.function as Record<string, unknown> | undefined
        const targetName = typeof choice.name === 'string' ? choice.name
          : fn && typeof fn.name === 'string' ? fn.name
          : ''
        if (targetName) {
          for (const [alias, original] of aliasMap) {
            if (original === targetName) {
              if (typeof choice.name === 'string') {
                body.tool_choice = { ...choice, name: alias }
              } else if (fn) {
                body.tool_choice = { ...choice, function: { ...fn, name: alias } }
              }
              break
            }
          }
        }
      }

      if (appended.length > 0) {
        // Add placeholder system note
        const toolList = appended.map((name) => `\`${name}\``).join(' or ')
        const note = appended.length > 1
          ? `\n\nDo not call the ${toolList} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
          : `\n\nDo not call the ${toolList} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`
        if (protocol === 'chat') {
          // For chat: prepend a system message
          const messages = (body.messages as Record<string, unknown>[]) ?? []
          const firstSystem = messages.find((m: Record<string, unknown>) => m.role === 'system')
          if (firstSystem && typeof firstSystem.content === 'string') {
            messages[0] = { ...firstSystem, content: `${firstSystem.content}${note}` }
          } else {
            body.messages = [{ role: 'system', content: note }, ...messages]
          }
        } else {
          body.instructions = ((body.instructions as string | undefined) ?? '') + note
        }
        logForDebugging(`[OpenCodeAdapter] Injected fingerprint tools: ${appended.join(', ')}; aliased: ${[...aliasMap.keys()].join(', ')}`)
      }

      // Tool choice: "auto" for Responses, undefined for chat (never "none")
      if (protocol === 'responses' && body.tool_choice === undefined) {
        body.tool_choice = 'auto'
      } else if (protocol === 'chat' && body.tool_choice === 'none') {
        delete (body as Record<string, unknown>).tool_choice
      }
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

export { CORE_TOOLS, FINGERPRINT_TOOL_DEFINITIONS }