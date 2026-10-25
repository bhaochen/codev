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
 * - Reasoning models (nemotron-3-ultra-free, etc.): enable thinking with reasoning_content field
 */
import type { ProviderAdapter } from './ProviderAdapter.js'
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { Credential } from '../auth/strategies.js'
import { getOpenCodeApiKey } from '../../../utils/auth.js'
import { getOpencodeModelMaxTokens, getCachedOpencodeModels, getOpencodeModelProviderApi } from '../../../utils/model/opencodeModels.js'
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

const ZEN_BASE = 'https://opencode.ai/zen/v1'
const INFERENCE_BASE = 'https://opencode.ai/inference/v1'

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = 'opencode' as const

  /**
   * True when the request will be sent as the free tier (Bearer public).
   * The upstream /inference/v1 gate only accepts the v2 client fingerprint on
   * free-tier traffic; a configured PAYG key stays on /zen/v1 (PR #4842 scope).
   * The literal string "public" counts as no key (see providers/opencode.ts).
   */
  isFreeTier(): boolean {
    const key = getOpenCodeApiKey()
    return !key || key === 'public'
  }

  resolveAuth(): Credential {
    const key = getOpenCodeApiKey()
    if (key && key !== 'public') {
      return { type: 'bearer', token: key }
    }
    return { type: 'bearer', token: 'public' }
  }

  getEndpoint(route: LLMRoute, request: LLMRequest): string {
    const configured = route.endpoint
    const model = request.model
    if (this.isFreeTier()) {
      // Free tier moved to /inference/v1 (OpenCode v2); /zen/v1 answers every
      // free request with 403 FreeTierError.
      // Use model-specific provider API endpoint from catalog (e.g., /inference/openai/v1, /inference/anthropic/v1)
      const modelProviderApi = getOpencodeModelProviderApi(model)
      const base = modelProviderApi
        ? modelProviderApi
        : configured
          ? getInferenceBaseUrl(configured)
          : `${INFERENCE_BASE}/chat/completions`
      // Ensure the endpoint includes the chat/completions path
      return base.endsWith('/chat/completions') ? base : `${base.replace(/\/$/, '')}/chat/completions`
    }
    // PAYG keeps /zen/v1 — normalize away any accidental /inference rewrite.
    const base = configured ?? `${ZEN_BASE}/chat/completions`
    return base.replace('/inference/', '/zen/')
  }

  buildHeaders(route: LLMRoute, request: LLMRequest): Record<string, string> {
    const protocol = route.protocol === 'openai-responses' ? 'responses'
      : route.protocol === 'anthropic-messages' ? 'anthropic'
      : 'chat'

    const tempHeaders = new Headers()
    const body = { model: request.model, messages: request.messages }
    const h = buildOpencodeHeaders(protocol, tempHeaders, body)

    // All keys stay lowercase: the caller merges these over its own defaults,
    // and a 'User-Agent' + 'user-agent' pair in one object collapses into
    // "ua, ua" in fetch's Headers — which upstream's anchored UA gate rejects.
    const headers: Record<string, string> = {}
    h.forEach((value, key) => { headers[key.toLowerCase()] = value })

    // buildOpencodeHeaders hardcodes "Bearer public"; override with the real
    // key on PAYG so billing actually uses the configured credential.
    if (!this.isFreeTier()) {
      const cred = this.resolveAuth()
      const token = cred.type === 'bearer' ? cred.token : cred.type === 'api-key' ? cred.key : 'public'
      if (protocol === 'anthropic') headers['x-api-key'] = token
      else headers.authorization = `Bearer ${token}`
    }

    if (this.isFreeTier()) {
      headers.accept = 'text/event-stream'
    }

    logForDebugging(`[OpenCodeAdapter] ${this.isFreeTier() ? 'inference/v1 (free tier)' : 'zen/v1 (PAYG)'} with v2 client fingerprint`)
    return headers
  }

  isReasoningModel(model: string): boolean {
    try {
      const models = getCachedOpencodeModels()
      const hit = models.find(m => m.id === model)
      return hit?.reasoning === true
    } catch {
      // No hardcoded fallback - if catalog not available, assume not a reasoning model
      return false
    }
  }

  supportsCapability(capability: 'reasoning_details' | 'prompt_cache' | 'reasoning', model?: string): boolean {
    if (capability === 'reasoning' || capability === 'reasoning_details') {
      return model ? this.isReasoningModel(model) : false
    }
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

    // Free-tier gate (PR #4842): every /inference/v1 request must be streaming
    // and must declare read/shell with exact definitions — unconditionally,
    // even with no caller tools and even for models whose names lack "free"
    // (big-pickle!). PAYG (/zen/v1) sends the body untouched.
    if (this.isFreeTier()) {
      body.stream = true

      // Inject read + shell with verbatim OpenCode definitions (handles a
      // missing body.tools by creating the array itself).
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
        // Add placeholder system note. Wording matters (PR #4842): "not
        // available" made the model also refuse the caller's own Read/Bash;
        // "placeholders ... use the other tools" kept those working.
        const toolList = appended.map((name) => `\`${name}\``).join(' or ')
        const note = appended.length > 1
          ? `\n\nDo not call the ${toolList} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
          : `\n\nDo not call the ${toolList} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`
        if (protocol === 'chat') {
          // Chat shape: append to the first system message wherever it sits;
          // insert one when the conversation has none. (Appending to index 0
          // blindly would overwrite a leading user message.)
          const messages = Array.isArray(body.messages)
            ? [...(body.messages as Record<string, unknown>[])]
            : []
          const systemIdx = messages.findIndex(
            (m) => m?.role === 'system' && typeof m.content === 'string',
          )
          if (systemIdx >= 0) {
            messages[systemIdx] = { ...messages[systemIdx], content: `${messages[systemIdx].content as string}${note}` }
          } else {
            messages.unshift({ role: 'system', content: note })
          }
          body.messages = messages
        } else {
          body.instructions = ((body.instructions as string | undefined) ?? '') + note
        }
        logForDebugging(`[OpenCodeAdapter] Injected fingerprint tools: ${appended.join(', ')}; aliased: ${[...aliasMap.keys()].join(', ')}`)
      }

      // Tool choice: "auto" for Responses, undefined for chat (never "none" —
      // upstream answers tool_choice "none" with 403 FreeTierError)
      if (protocol === 'responses' && body.tool_choice === undefined) {
        body.tool_choice = 'auto'
      } else if (protocol === 'chat' && body.tool_choice === 'none') {
        delete (body as Record<string, unknown>).tool_choice
      }
    }

    // Enable thinking for reasoning models (e.g., nemotron-3-ultra-free)
    // These models use the reasoning_content field for streaming reasoning output
    if (this.isReasoningModel(route.model)) {
      body.thinking = { type: 'enabled' }
      body.enable_thinking = true
      body.chat_template_kwargs = { thinking: true, enable_thinking: true }
    }

    return body
  }

  /**
   * Catalog-driven free-model check (cost 0). Used for capability decisions;
   * the free-tier wire behavior above keys off isFreeTier() (no PAYG key),
   * not the model name.
   */
  isFreeModel(model: string): boolean {
    if (model.includes('free') || model.includes('contributor')) return true
    try {
      const { getCachedOpencodeModels } = require('../../../utils/model/opencodeModels.js') as typeof import('../../../utils/model/opencodeModels.js')
      const list = getCachedOpencodeModels()
      const hit = list.find(m => m.id === model || model.includes(m.id) || m.id.includes(model))
      return hit?.isFree ?? false
    } catch { return false }
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