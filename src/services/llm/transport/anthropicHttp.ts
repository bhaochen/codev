/**
 * Native Anthropic HTTP transport — first-party Anthropic API without the SDK.
 *
 * Single home for first-party request preparation shared by streaming
 * inference, the non-streaming fallback, API key verification, and token
 * counting:
 * - OAuth refresh + default headers (x-app, User-Agent, session, custom,
 *   container/remote/client-app, additional protection), API-key-helper
 *   Authorization, and staging base-URL resolution — replicating the
 *   first-party branch of the legacy api/client.ts client factory.
 * - `nativeAnthropicPost`: JSON POST with betas-as-header, timeout/abort
 *   mapping, and SDK-identical error construction via APIError.generate.
 *
 * Bedrock / Vertex / Foundry keep their SDK clients (out of scope).
 */
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk/error'
import { getOauthConfig } from '../../../constants/oauth.js'
import { getSessionId, getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from '../../../utils/auth.js'
import { randomUUID } from 'crypto'
import { logForDebugging } from '../../../utils/debug.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { getUserAgent } from '../../../utils/http.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from '../../../utils/model/providers.js'
import { httpRequest } from './http.js'

export function getNativeCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS
  if (!customHeadersEnv) return customHeaders
  for (const headerString of customHeadersEnv.split(/\n|\r\n/)) {
    if (!headerString.trim()) continue
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) customHeaders[name] = value
  }
  return customHeaders
}

export async function configureNativeApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

export function resolveNativeAnthropicBaseUrl(): string {
  if (process.env.USER_TYPE === 'ant' && isEnvTruthy(process.env.USE_STAGING_OAUTH)) {
    return getOauthConfig().BASE_API_URL
  }
  return process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, '') || 'https://api.anthropic.com'
}

export async function buildNativeFirstPartyHeaders(): Promise<{
  headers: Record<string, string>
  baseUrl: string
}> {
  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getNativeCustomHeaders()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
    ...(remoteSessionId ? { 'x-claude-remote-session-id': remoteSessionId } : {}),
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION)) {
    headers['x-anthropic-additional-protection'] = 'true'
  }
  await checkAndRefreshOAuthTokenIfNeeded()
  if (!isClaudeAISubscriber()) {
    await configureNativeApiKeyHeaders(headers, getIsNonInteractiveSession())
  }
  return { headers, baseUrl: resolveNativeAnthropicBaseUrl() }
}

export async function resolveNativeFirstPartyAuth(
  apiKeyOverride?: string | null,
): Promise<Record<string, string>> {
  if (isClaudeAISubscriber()) {
    const token = getClaudeAIOAuthTokens()?.accessToken
    return token ? { Authorization: `Bearer ${token}` } : {}
  }
  const apiKey = apiKeyOverride ?? getAnthropicApiKey()
  return apiKey ? { 'x-api-key': apiKey } : {}
}

function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return callerSignal
  const timeoutSignal =
    typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.abort()
  if (callerSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal])
  }
  return callerSignal ?? timeoutSignal
}

/**
 * POST a JSON body to a first-party Anthropic API path.
 *
 * - `betas` are sent as the `anthropic-beta` header (SDK parity), never in body.
 * - A caller abort surfaces as APIUserAbortError; a timeout abort surfaces as
 *   APIConnectionTimeoutError; non-2xx surfaces via APIError.generate so
 *   status subclasses and the `status + compact-JSON` message match the SDK.
 */
export async function nativeAnthropicPost<T = any>(args: {
  path: string
  body: Record<string, any>
  betas?: string[]
  signal?: AbortSignal
  timeoutMs?: number
  fetchOverride?: typeof fetch
  apiKeyOverride?: string | null
  source?: string
}): Promise<{ json: T; headers: Headers; status: number }> {
  const { betas, ...body } = args.body
  const { headers: nativeHeaders, baseUrl } = await buildNativeFirstPartyHeaders()
  const authHeaders = await resolveNativeFirstPartyAuth(args.apiKeyOverride)
  const headers: Record<string, string> = {
    ...nativeHeaders,
    ...authHeaders,
    'anthropic-version': '2023-06-01',
    ...(Array.isArray(betas) && betas.length > 0 && {
      'anthropic-beta': betas.join(','),
    }),
  }
  // Client-side request ID so timeouts (no server request ID) still
  // correlate with server logs. First-party only — mirrors buildFetch.
  if (
    getAPIProvider() === 'firstParty' &&
    isFirstPartyAnthropicBaseUrl() &&
    !headers[CLIENT_REQUEST_ID_HEADER]
  ) {
    headers[CLIENT_REQUEST_ID_HEADER] = randomUUID()
  }
  try {
    logForDebugging(`[API REQUEST] ${args.path} source=${args.source ?? 'unknown'}`)
  } catch {
    // never let logging crash the fetch
  }
  const signal = combineAbortSignals(args.signal, args.timeoutMs)
  let response: Response
  try {
    response = await httpRequest(
      {
        url: `${baseUrl}${args.path}`,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      },
      args.fetchOverride,
    )
  } catch (err) {
    if (args.signal?.aborted) throw new APIUserAbortError()
    throw new APIConnectionTimeoutError({
      message: err instanceof Error ? err.message : String(err),
    })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let errorBody: any
    try {
      errorBody = JSON.parse(text)
    } catch {
      errorBody = undefined
    }
    throw APIError.generate(response.status, errorBody, text || undefined, response.headers)
  }
  return { json: (await response.json()) as T, headers: response.headers, status: response.status }
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
