/**
 * ChatGPT 订阅后端 OAuth（codev 适配版，移植自 claude-code 的同名模块）。
 *
 * 与 claude-code 的区别：认证凭证存进 codev 自己的全局 config
 * （见 src/utils/auth.ts 的 OpenAIAuthTokens / saveOpenAIAuthTokens），
 * 不引入独立的 openai-chatgpt-auth.json 文件。
 *
 * 职责：
 * - 原生 device-code 登录（不依赖 codex CLI）
 * - access token 到期前 5 分钟自动 refresh（oauth/token + refresh_token）
 * - 从 JWT claims 提取 ChatGPT account id（responses 后端 header 用）
 */
import type { OpenAIAuthTokens } from '../../../utils/auth.js'
import {
  getOpenAIAuthTokens,
  saveOpenAIAuthTokens,
} from '../../../utils/auth.js'
import { logForDebugging } from '../../../utils/debug.js'

const ISSUER = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const REFRESH_SKEW_MS = 5 * 60 * 1000
const REFRESH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'

export type ChatGPTDeviceCode = {
  verificationUrl: string
  userCode: string
  deviceAuthId: string
  intervalSeconds: number
}

export type ChatGPTAuth = {
  accessToken: string
  /** ChatGPT account id（Responses 请求的 ChatGPT-Account-Id header）。 */
  accountId?: string
}

function parseJSONRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    )
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return parseJSONRecord(json)
  } catch {
    return null
  }
}

function getOpenAIAuthClaims(token: string): Record<string, unknown> {
  const payload = decodeJwtPayload(token)
  const nested = payload?.['https://api.openai.com/auth']
  if (nested && typeof nested === 'object') {
    return nested as Record<string, unknown>
  }
  return payload ?? {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function extractAccountId(accessToken: string): string | undefined {
  const claims = getOpenAIAuthClaims(accessToken)
  return (
    asString(claims.chatgpt_account_id) ??
    asString(claims.chatgpt_account_user_id) ??
    asString(claims.account_id)
  )
}

function getTokenExpiryMs(accessToken: string): number | null {
  const payload = decodeJwtPayload(accessToken)
  const exp = payload?.exp
  return typeof exp === 'number' ? exp * 1000 : null
}

function toOpenAIAuthTokens(params: {
  idToken: string
  accessToken: string
  refreshToken: string
}): OpenAIAuthTokens {
  const expiresAt = getTokenExpiryMs(params.accessToken)
  return {
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
    expiresAt: expiresAt !== null ? expiresAt : undefined,
    lastRefresh: Date.now(),
  }
}

async function postJSON<T>(
  url: string,
  body: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`ChatGPT auth request failed (${res.status})`)
  }
  return (await res.json()) as T
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `ChatGPT token request failed (${res.status})${text ? `: ${text}` : ''}`,
    )
  }
  return (await res.json()) as T
}

/**
 * 请求一个 device code（用户到 auth.openai.com/codex/device 输入 code 授权）。
 * 不依赖 codex CLI。
 */
export async function requestChatGPTDeviceCode(): Promise<ChatGPTDeviceCode> {
  type UserCodeResponse = {
    device_auth_id: string
    user_code?: string
    usercode?: string
    interval?: string | number
  }
  const data = await postJSON<UserCodeResponse>(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID },
  )
  const userCode = data.user_code ?? data.usercode
  if (!data.device_auth_id || !userCode) {
    throw new Error('ChatGPT auth response did not include a device code')
  }
  const interval =
    typeof data.interval === 'number'
      ? data.interval
      : Number.parseInt(data.interval ?? '5', 10)
  return {
    verificationUrl: `${ISSUER}/codex/device`,
    userCode,
    deviceAuthId: data.device_auth_id,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
  }
}

async function pollForAuthorizationCode(
  deviceCode: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  type TokenPollResponse = {
    authorization_code: string
    code_verifier: string
  }
  const started = Date.now()
  while (Date.now() - started < 15 * 60 * 1000) {
    if (signal?.aborted) throw new Error('ChatGPT login cancelled')
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceCode.deviceAuthId,
        user_code: deviceCode.userCode,
      }),
      signal,
    })
    if (res.ok) {
      const data = (await res.json()) as TokenPollResponse
      return {
        authorizationCode: data.authorization_code,
        codeVerifier: data.code_verifier,
      }
    }
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`ChatGPT device auth failed (${res.status})`)
    }
    await new Promise(resolve =>
      setTimeout(resolve, deviceCode.intervalSeconds * 1000),
    )
  }
  throw new Error('ChatGPT device auth timed out after 15 minutes')
}

async function exchangeAuthorizationCode(params: {
  authorizationCode: string
  codeVerifier: string
}): Promise<OpenAIAuthTokens> {
  type TokenResponse = {
    id_token: string
    access_token: string
    refresh_token: string
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.authorizationCode,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: params.codeVerifier,
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  return toOpenAIAuthTokens({
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  })
}

/**
 * 用 device code 完成 ChatGPT 登录（轮询授权 → 换取 token → 存入全局 config）。
 */
export async function completeChatGPTDeviceLogin(
  deviceCode: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<OpenAIAuthTokens> {
  const code = await pollForAuthorizationCode(deviceCode, signal)
  const tokens = await exchangeAuthorizationCode(code)
  saveOpenAIAuthTokens(tokens)
  return tokens
}

export function isChatGPTAuthEnabled(): boolean {
  return process.env.OPENAI_AUTH_MODE === 'chatgpt'
}

async function refreshTokens(tokens: OpenAIAuthTokens): Promise<OpenAIAuthTokens> {
  type TokenResponse = {
    id_token: string
    access_token: string
    refresh_token?: string
  }
  if (!tokens.refreshToken) {
    throw new Error('ChatGPT auth has no refresh token; log in again via /login')
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
    scope: REFRESH_SCOPE,
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  return toOpenAIAuthTokens({
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
  })
}

/**
 * 返回可用于 Responses 后端的有效 ChatGPT access token（必要时自动刷新）。
 * 凭证来自 codev 全局 config（openAiAccessToken / openAiRefreshToken）。
 */
export async function getValidChatGPTAuth(): Promise<ChatGPTAuth> {
  const tokens = getOpenAIAuthTokens()
  if (!tokens) {
    throw new Error(
      'ChatGPT account is not logged in. Run /login and select ChatGPT account with subscription.',
    )
  }

  const expiresAt =
    typeof tokens.expiresAt === 'number' ? tokens.expiresAt : null
  let validTokens = tokens
  if (expiresAt !== null && expiresAt <= Date.now() + REFRESH_SKEW_MS) {
    try {
      validTokens = await refreshTokens(tokens)
      saveOpenAIAuthTokens(validTokens)
    } catch (error) {
      logForDebugging(
        `[ChatGPT] token refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { level: 'warn' },
      )
    }
  }

  return {
    accessToken: validTokens.accessToken,
    accountId: extractAccountId(validTokens.accessToken),
  }
}