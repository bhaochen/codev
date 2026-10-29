import chalk from 'chalk'
import { exec } from 'child_process'
import { execa, execaSync } from 'execa'
import { mkdir, readFile, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import {
  getAPIProvider,
  getCodevEnvApiKey,
  getCodevEnvBaseUrl,
  getCodevEnvModel,
  getEnvCustomApiKey,
  getEnvCustomBaseUrl,
  getEnvCustomModel,
} from 'src/utils/model/providers.js'
import {
  getIsNonInteractiveSession,
  preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import {
  getMockSubscriptionType,
  shouldUseMockSubscription,
} from '../services/mockRateLimits.js'
import type { OAuthTokens, SubscriptionType } from '../services/oauth/types.js'
import {
  getApiKeyFromFileDescriptor,
} from './authFileDescriptor.js'
import {
  maybeRemoveApiKeyFromMacOSKeychainThrows,
  normalizeApiKeyForConfig,
} from './authPortable.js'
import {
  checkStsCallerIdentity,
  clearAwsIniCache,
  isValidAwsStsOutput,
} from './aws.js'
import { AwsAuthStatusManager } from './awsAuthStatusManager.js'
import { clearBetasCaches } from './betas.js'
import {
  type AccountInfo,
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  getGlobalConfigSnapshot,
  normalizeCustomEndpoints,
  saveGlobalConfig,
} from './config.js'
import { logAntError, logForDebugging } from './debug.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
  isRunningOnHomespace,
} from './envUtils.js'
import { errorMessage } from './errors.js'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { memoizeWithTTLAsync } from './memoize.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  clearLegacyApiKeyPrefetch,
  getLegacyApiKeyPrefetchResult,
} from './secureStorage/keychainPrefetch.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  // TODO
  getUsername,
} from './secureStorage/macOsKeychainHelpers.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { jsonParse } from './slowOperations.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'

/** Default TTL for API key helper cache in milliseconds (5 minutes) */
const DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000

/**
 * CCR and Claude Desktop spawn the CLI with OAuth and should never fall back
 * to the user's ~/.local/share/codev/settings.json API-key config (apiKeyHelper,
 * env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN). Those settings exist for
 * the user's terminal CLI, not managed sessions. Without this guard, a user
 * who runs `claude` in their terminal with an API key sees every CCD session
 * also use that key — and fail if it's stale/wrong-org.
 */
/** Whether we are supporting direct 1P auth. */
// this code is closely related to getAuthTokenSource
export function isAnthropicAuthEnabled(): boolean {
  return false
}

/** Where the auth token is being sourced from, if any. */
// this code is closely related to isAnthropicAuthEnabled
export function getAuthTokenSource() {
  return { source: 'none' as const, hasToken: false }
}

export type ApiKeySource =
  | 'ANTHROPIC_API_KEY'
  | 'apiKeyHelper'
  | '/login managed key'
  | 'none'

export type OpenRouterApiKeySource =
  | 'OPENROUTER_API_KEY'
  | 'ANTHROPIC_AUTH_TOKEN'
  | '/login managed OpenRouter key'
  | 'none'

export function getAnthropicApiKey(): null | string {
  return null
}

export function hasAnthropicApiKeyAuth(): boolean {
  return false
}

export function getOpenRouterApiKey(): null | string {
  return getOpenRouterApiKeyWithSource().key
}

export function getOpenRouterApiKeyWithSource(): {
  key: null | string
  source: OpenRouterApiKeySource
} {
  if (process.env.OPENROUTER_API_KEY) {
    return { key: process.env.OPENROUTER_API_KEY, source: 'OPENROUTER_API_KEY' }
  }
  
  // Check if current provider is OpenRouter (both from cache and file)
  const apiProvider = getAPIProvider()
  let isAuthProviderOpenRouter = apiProvider === 'openrouter'
  
  // If getAPIProvider() returns null, check the config file directly
  if (!isAuthProviderOpenRouter && apiProvider === null) {
    const authProvider = getConfiguredAuthProviderFromFile()
    isAuthProviderOpenRouter = authProvider === 'openrouter'
  }
  
  if (process.env.ANTHROPIC_AUTH_TOKEN && isAuthProviderOpenRouter) {
    return {
      key: process.env.ANTHROPIC_AUTH_TOKEN,
      source: 'ANTHROPIC_AUTH_TOKEN',
    }
  }

  const key = getGlobalConfig().openRouterApiKey
  return key
    ? { key, source: '/login managed OpenRouter key' }
    : { key: null, source: 'none' }
}

// Read authProvider from SQLite directly during early startup.
export function getConfiguredAuthProviderFromFile(): 'anthropic' | 'openrouter' | 'openai' | 'local' | 'opencode' | 'nvidia' | 'kiro' | 'custom' | null {
  try {
    const config = getGlobalConfigSnapshot()

    if (config.authProvider) {
      return config.authProvider
    }
  } catch (error) {
    // Ignore errors
  }

  // No explicit authProvider configured, return null
  return null
}

function isValidApiKey(apiKey: string): boolean {
  // Only allow alphanumeric characters, dashes, and underscores
  return /^[a-zA-Z0-9-_]+$/.test(apiKey)
}

export async function saveOpenRouterApiKey(apiKey: string): Promise<void> {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error(
      'Invalid API key: API key must be a non-empty string.',
    )
  }

  // Trim the API key to remove any leading/trailing whitespace
  const trimmedKey = apiKey.trim()

  if (!trimmedKey) {
    throw new Error(
      'Invalid API key: API key cannot be empty or whitespace only.',
    )
  }

  if (!isValidApiKey(trimmedKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  saveGlobalConfig(current => ({
    ...current,
    authProvider: 'openrouter',
    openRouterApiKey: trimmedKey,
  }))
  // Clear provider cache so it will be re-read on next access
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
}

export function getNvidiaApiKey(): string | null {
  if (process.env.NVIDIA_API_KEY) {
    return process.env.NVIDIA_API_KEY
  }

  const config = getGlobalConfig()
  return config.nvidiaApiKey || null
}

export async function saveNvidiaApiKey(apiKey: string): Promise<void> {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('Invalid API key: API key must be a non-empty string.')
  }

  const trimmedKey = apiKey.trim()

  if (!trimmedKey) {
    throw new Error('Invalid API key: API key cannot be empty or whitespace only.')
  }

  saveGlobalConfig(current => ({
    ...current,
    authProvider: 'nvidia',
    nvidiaApiKey: trimmedKey,
  }))
  // Clear provider cache so it will be re-read on next access
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
}

export async function saveOpenCodeApiKey(apiKey: string, modelName?: string): Promise<void> {
  saveGlobalConfig(current => ({
    ...current,
    authProvider: 'opencode',
    openCodeApiKey: apiKey || undefined,
    openCodeModelName: modelName || undefined,
  }))
  // Clear provider cache so it will be re-read on next access
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
}

export function getOpenCodeApiKey(): null | string {
  const config = getGlobalConfig()
  return config.openCodeApiKey || null
}

export function getOpenCodeModelName(): null | string {
  const config = getGlobalConfig()
  if (config.authProvider === 'opencode' && config.openCodeModelName) {
    return config.openCodeModelName
  }
  // Fallback: read config file directly in case getGlobalConfig() is stale
  try {
    const fileConfig = getGlobalConfigSnapshot()
    if (fileConfig.authProvider === 'opencode' && fileConfig.openCodeModelName) {
      return fileConfig.openCodeModelName
    }
  } catch {
    // Ignore errors
  }
  return null
}

export async function saveLocalModelConfig(baseUrl: string, modelName: string, contextWindow?: number): Promise<void> {
  if (!baseUrl.trim()) {
    throw new Error('Base URL cannot be empty')
  }

  try {
    // 验证 URL 格式
    new URL(baseUrl)
  } catch {
    throw new Error('Invalid URL format')
  }

  saveGlobalConfig(current => {
    const newConfig: any = {
      ...current,
      authProvider: 'local',
      localBaseUrl: baseUrl,
      localModelName: modelName,
    }
    if (contextWindow !== undefined) {
      newConfig.localModelContextWindow = contextWindow
    }
    return newConfig
  })

  // Clear provider cache so it will be re-read on next access
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
}

export async function saveCustomApiConfig(baseUrl: string, modelName: string, apiKey?: string): Promise<void> {
  if (!baseUrl.trim()) {
    throw new Error('Base URL cannot be empty')
  }
  try {
    new URL(baseUrl)
  } catch {
    throw new Error('Invalid URL format')
  }
  saveGlobalConfig(current => {
    // `current` comes straight from the store — it is not run through
    // migrateConfigFields, so normalize corrupt (e.g. string) values here.
    const endpoints = normalizeCustomEndpoints(current.customEndpoints)
    const idx = endpoints.findIndex(e => e.baseUrl === baseUrl)
    if (idx >= 0) {
      // Update existing endpoint in-place
      const updated = [...endpoints]
      updated[idx] = { ...updated[idx], modelName, apiKey: apiKey ?? undefined }
      return { ...current, customEndpoints: updated, currentCustomEndpointIndex: idx }
    }
    // Add new endpoint (enabled by default) and select it as primary
    const newEp = { id: `${Date.now()}`, baseUrl, modelName, apiKey: apiKey ?? undefined, enabled: true }
    return { ...current, customEndpoints: [...endpoints, newEp], currentCustomEndpointIndex: endpoints.length }
  })
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
}

/** Remove an endpoint by its ID and adjust the active index. */
export async function removeCustomEndpoint(id: string): Promise<void> {
  saveGlobalConfig(current => {
    const endpoints = normalizeCustomEndpoints(current.customEndpoints)
    const idx = endpoints.findIndex(e => e.id === id)
    if (idx < 0) return current
    const remaining = endpoints.filter(e => e.id !== id)
    const activeIdx = Math.min(current.currentCustomEndpointIndex ?? 0, remaining.length - 1)
    return { ...current, customEndpoints: remaining, currentCustomEndpointIndex: activeIdx >= 0 ? activeIdx : undefined }
  })
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
}

/** Switch the currently active custom endpoint by index. */
export async function setActiveCustomEndpointIndex(idx: number): Promise<void> {
  saveGlobalConfig(current => {
    const endpoints = normalizeCustomEndpoints(current.customEndpoints)
    const validIdx = idx >= 0 && idx < endpoints.length ? idx : 0
    return { ...current, currentCustomEndpointIndex: validIdx }
  })
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
}

/**
 * Toggle an endpoint's enabled flag (its "activated" state in /login).
 * Multiple endpoints may be enabled at once; disabled ones are excluded
 * from /model and from request routing.
 */
export async function toggleCustomEndpointEnabled(id: string): Promise<boolean> {
  let nowEnabled = false
  saveGlobalConfig(current => {
    const endpoints = normalizeCustomEndpoints(current.customEndpoints)
    const idx = endpoints.findIndex(e => e.id === id)
    if (idx < 0) return current
    nowEnabled = endpoints[idx].enabled === false
    const updated = [...endpoints]
    updated[idx] = { ...updated[idx], enabled: nowEnabled }
    return { ...current, customEndpoints: updated }
  })
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
  return nowEnabled
}

export function getCustomApiConfig(): { baseUrl: string | null; modelName: string | null; apiKey: string | null } {
  // Priority: CODEV_* env (explicit per-run override) > stored config
  // (the user's persistent /login choice) > generic OPENAI_* env.
  const envBaseUrl = getEnvCustomBaseUrl() ?? null
  const envModelName = getEnvCustomModel() ?? null
  const envApiKey = getEnvCustomApiKey() ?? null
  try {
    const config = getGlobalConfigSnapshot()
    const endpoints = normalizeCustomEndpoints(config.customEndpoints)
    const activeIdx = config.currentCustomEndpointIndex ?? 0
    const activeEp = endpoints[activeIdx]
    return {
      baseUrl: getCodevEnvBaseUrl() ?? activeEp?.baseUrl ?? envBaseUrl,
      modelName: getCodevEnvModel() ?? activeEp?.modelName ?? config.customModelName ?? envModelName,
      apiKey: getCodevEnvApiKey() ?? activeEp?.apiKey ?? envApiKey,
    }
  } catch {
    return {
      baseUrl: getCodevEnvBaseUrl() ?? envBaseUrl,
      modelName: getCodevEnvModel() ?? envModelName,
      apiKey: getCodevEnvApiKey() ?? envApiKey,
    }
  }
}

export function getLocalModelName(): string | null {
  try {
    const config = getGlobalConfigSnapshot()

    // Return the stored value regardless of the active authProvider so the
    // /login Local screen can pre-fill it after switching providers.
    // Runtime callers already gate on authProvider === 'local' themselves.
    if (config.localModelName) {
      return config.localModelName
    }
    return null
  } catch (error) {
    return null
  }
}

export function getLocalBaseUrl(): string | null {
  try {
    const config = getGlobalConfigSnapshot()

    // Return the stored value regardless of the active authProvider so the
    // /login Local screen can pre-fill it after switching providers.
    // Runtime callers already gate on authProvider === 'local' themselves.
    if (config.localBaseUrl) {
      return config.localBaseUrl
    }
    return null
  } catch (error) {
    return null
  }
}

export function getLocalModelContextWindowConfig(): number | null {
  try {
    const config = getGlobalConfigSnapshot()

    // Return the stored value regardless of the active authProvider so the
    // /login Local screen can pre-fill it after switching providers.
    // Runtime callers already gate on authProvider === 'local' themselves.
    if (config.localModelContextWindow) {
      return config.localModelContextWindow
    }
    return null
  } catch (error) {
    return null
  }
}

export type KiroAuthTokens = {
  accessToken: string
  refreshToken?: string | null
  profileArn?: string | null
  region?: string | null
  expiresAt?: number | null
}

export async function saveKiroAuthTokens(tokens: KiroAuthTokens): Promise<void> {
  saveGlobalConfig(current => ({
    ...current,
    authProvider: 'kiro',
    kiroAccessToken: tokens.accessToken,
    kiroRefreshToken: tokens.refreshToken ?? undefined,
    kiroProfileArn: tokens.profileArn ?? undefined,
    kiroRegion: tokens.region ?? undefined,
    kiroTokenExpiresAt: tokens.expiresAt ?? undefined,
  }))
  // Clear provider cache so it will be re-read on next access
  const { clearStoredProviderCache } = await import('./model/providers.js')
  clearStoredProviderCache()
}

export function getKiroAccessToken(): string | null {
  const config = getGlobalConfig()
  return config.kiroAccessToken || null
}

export function getKiroRefreshToken(): string | null {
  const config = getGlobalConfig()
  return config.kiroRefreshToken || null
}

export function getKiroProfileArn(): string | null {
  const config = getGlobalConfig()
  return config.kiroProfileArn || null
}

export function getKiroRegion(): string | null {
  const config = getGlobalConfig()
  return config.kiroRegion || null
}

/**
 * Refresh Kiro access token using refresh token.
 * Calls Kiro auth service (same as 9router's KiroService.refreshToken).
 */
export async function refreshKiroAccessToken(): Promise<string | null> {
  const refreshToken = getKiroRefreshToken()
  const profileArn = getKiroProfileArn()
  const region = getKiroRegion() || 'us-east-1'

  if (!refreshToken) {
    console.error('[Kiro] No refresh token available')
    return null
  }

  try {
    // Kiro auth service endpoint (same as 9router)
    const authService = 'https://prod.us-east-1.auth.desktop.kiro.dev'
    
    const response = await fetch(`${authService}/refreshToken`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error(`[Kiro] Token refresh failed: ${error}`)
      return null
    }

    const data = await response.json()
    const newAccessToken = data.accessToken
    const newRefreshToken = data.refreshToken || refreshToken
    const newProfileArn = data.profileArn || profileArn
    const expiresIn = data.expiresIn || 3600

    // Save new tokens
    await saveKiroAuthTokens({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      profileArn: newProfileArn,
      region,
      expiresAt: Date.now() + expiresIn * 1000,
    })

    return newAccessToken
  } catch (error) {
    console.error('[Kiro] Token refresh error:', error)
    return null
  }
}

/**
 * Get valid Kiro access token, refreshing if needed.
 */
export async function getValidKiroAccessToken(): Promise<string | null> {
  const accessToken = getKiroAccessToken()
  const expiresAt = getGlobalConfig().kiroTokenExpiresAt

  // If we have a token and it's not expired (with 5 min buffer), return it
  if (accessToken && expiresAt && Date.now() < expiresAt - 5 * 60 * 1000) {
    return accessToken
  }

  // Otherwise refresh
  return refreshKiroAccessToken()
}

export interface KiroAutoDetectResult {
  found: boolean
  refreshToken?: string
  profileArn?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  error?: string
  source?: 'ide' | 'cli'
}

/**
 * Auto-detect Kiro authentication from AWS SSO cache and Kiro IDE profile.
 * Mirrors 9router's auto-import logic.
 */
export async function autoDetectKiroAuth(): Promise<KiroAutoDetectResult> {
  const { homedir } = await import('os')
  const { join } = await import('path')
  const { readdir, readFile } = await import('fs/promises')

  // First try kiro-cli SQLite database (most common for CLI users)
  const cliResult = await tryDetectFromKiroCLI()
  if (cliResult.found) {
    return { ...cliResult, source: 'cli' }
  }

  // Then try AWS SSO cache + Kiro IDE profile (for IDE users)
  return tryDetectFromIDE()
}

async function tryDetectFromKiroCLI(): Promise<KiroAutoDetectResult> {
  const { homedir } = await import('os')
  const { join } = await import('path')
  const { readFile } = await import('fs/promises')

  const cliDbPath = join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3')
  
  try {
    // Check if file exists
    await readFile(cliDbPath)
  } catch {
    return { found: false, error: 'kiro-cli database not found' }
  }

  try {
    // Use Bun's built-in SQLite (no external dependency)
    const { Database } = await import('bun:sqlite')
    const db = new Database(cliDbPath, { readonly: true })
    
    try {
      const row = db
        .query('SELECT value FROM auth_kv WHERE key = ?')
        .get('kirocli:social:token') as { value?: string } | undefined
      if (!row?.value) {
        return { found: false, error: 'No auth token found in kiro-cli database' }
      }

      const auth = JSON.parse(row.value)
      const refreshToken = auth.refresh_token
      const profileArn = auth.profile_arn

      if (!refreshToken || typeof refreshToken !== 'string' || !refreshToken.startsWith('aorAAAAAG')) {
        return { found: false, error: 'Invalid refresh token format in kiro-cli database' }
      }

      if (!profileArn) {
        return { found: false, error: 'No profile ARN found in kiro-cli database' }
      }

      // Determine auth method from provider
      const authMethod = auth.provider === 'github' || auth.provider === 'google' ? 'social' : 'builder-id'

      return {
        found: true,
        refreshToken,
        profileArn,
        region: 'us-east-1', // kiro-cli profile ARN is already normalized
        authMethod,
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return { found: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function tryDetectFromIDE(): Promise<KiroAutoDetectResult> {
  const { homedir } = await import('os')
  const { join } = await import('path')
  const { readdir, readFile } = await import('fs/promises')

  try {
    const cachePath = join(homedir(), '.aws/sso/cache')

    let files: string[]
    try {
      files = await readdir(cachePath)
    } catch {
      return { found: false, error: 'AWS SSO cache not found. Please login to Kiro IDE first.' }
    }

    let refreshToken: string | null = null
    let tokenData: Record<string, unknown> | null = null
    let foundFile: string | null = null

    // First try kiro-auth-token.json
    const kiroTokenFile = 'kiro-auth-token.json'
    if (files.includes(kiroTokenFile)) {
      try {
        const content = await readFile(join(cachePath, kiroTokenFile), 'utf-8')
        const data = JSON.parse(content)
        if (data.refreshToken && typeof data.refreshToken === 'string' && data.refreshToken.startsWith('aorAAAAAG')) {
          refreshToken = data.refreshToken
          foundFile = kiroTokenFile
          tokenData = data
        }
      } catch {
        // Continue to search other files
      }
    }

    // If not found, search all .json files
    if (!refreshToken) {
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const content = await readFile(join(cachePath, file), 'utf-8')
          const data = JSON.parse(content)
          if (data.refreshToken && typeof data.refreshToken === 'string' && data.refreshToken.startsWith('aorAAAAAG')) {
            refreshToken = data.refreshToken
            foundFile = file
            tokenData = data
            break
          }
        } catch {
          continue
        }
      }
    }

    if (!refreshToken) {
      return { found: false, error: 'Kiro token not found in AWS SSO cache. Please login to Kiro IDE first.' }
    }

    // For IDC/organization tokens, resolve clientId and clientSecret from
    // the linked client registration file (referenced by clientIdHash).
    let clientId: string | null = null
    let clientSecret: string | null = null
    const region = (tokenData?.region as string) || 'us-east-1'
    const authMethod = (tokenData?.authMethod as string) || 'builder-id'

    if (tokenData?.clientIdHash && typeof tokenData.clientIdHash === 'string') {
      const clientFile = `${tokenData.clientIdHash}.json`
      try {
        const clientContent = await readFile(join(cachePath, clientFile), 'utf-8')
        const clientData = JSON.parse(clientContent)
        if (clientData.clientId && clientData.clientSecret) {
          clientId = clientData.clientId
          clientSecret = clientData.clientSecret
        }
      } catch {
        // Client registration file not found - continue without it
      }
    }

    // Read profileArn from Kiro IDE's profile.json.
    // Important: the runtime gateway requires us-east-1 in the ARN regardless
    // of the IDC region, so we normalize the region in the ARN to us-east-1.
    let profileArn: string | null = null
    const kiroProfilePaths = [
      // Windows
      join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
      // Linux
      join(homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
      // macOS
      join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
    ]
    for (const profilePath of kiroProfilePaths) {
      try {
        const profileContent = await readFile(profilePath, 'utf-8')
        const profileData = JSON.parse(profileContent)
        if (profileData.arn) {
          // Normalize region to us-east-1 for the runtime gateway
          profileArn = profileData.arn.replace(/arn:aws:codewhisperer:[^:]+:/, 'arn:aws:codewhisperer:us-east-1:')
          break
        }
      } catch {
        continue
      }
    }
  } catch {
    // If any unexpected error occurs, return failure
    return { found: false, error: 'Unexpected error during IDE detection' }
  }
}

export function getAnthropicApiKeyWithSource(
  _opts: { skipRetrievingKeyFromApiKeyHelper?: boolean } = {},
): { key: null; source: ApiKeySource } {
  return { key: null, source: 'none' }
}

export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) {
    return getSettingsForSource('flagSettings')?.apiKeyHelper
  }
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.apiKeyHelper
}

/**
 * Check if the configured apiKeyHelper comes from project settings (projectSettings or localSettings)
 */
function isApiKeyHelperFromProjectOrLocalSettings(): boolean {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.apiKeyHelper === apiKeyHelper ||
    localSettings?.apiKeyHelper === apiKeyHelper
  )
}

/**
 * Get the configured awsAuthRefresh from settings
 */
function getConfiguredAwsAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsAuthRefresh
}

/**
 * Check if the configured awsAuthRefresh comes from project settings
 */
export function isAwsAuthRefreshFromProjectSettings(): boolean {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  if (!awsAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsAuthRefresh === awsAuthRefresh ||
    localSettings?.awsAuthRefresh === awsAuthRefresh
  )
}

/**
 * Get the configured awsCredentialExport from settings
 */
function getConfiguredAwsCredentialExport(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsCredentialExport
}

/**
 * Check if the configured awsCredentialExport comes from project settings
 */
export function isAwsCredentialExportFromProjectSettings(): boolean {
  const awsCredentialExport = getConfiguredAwsCredentialExport()
  if (!awsCredentialExport) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsCredentialExport === awsCredentialExport ||
    localSettings?.awsCredentialExport === awsCredentialExport
  )
}

/**
 * Calculate TTL in milliseconds for the API key helper cache
 * Uses CLAUDE_CODE_API_KEY_HELPER_TTL_MS env var if set and valid,
 * otherwise defaults to 5 minutes
 */
export function calculateApiKeyHelperTTL(): number {
  const envTtl = process.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS

  if (envTtl) {
    const parsed = parseInt(envTtl, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
    logForDebugging(
      `Found CLAUDE_CODE_API_KEY_HELPER_TTL_MS env var, but it was not a valid number. Got ${envTtl}`,
      { level: 'error' },
    )
  }

  return DEFAULT_API_KEY_HELPER_TTL
}

// Async API key helper with sync cache for non-blocking reads.
// Epoch bumps on clearApiKeyHelperCache() — orphaned executions check their
// captured epoch before touching module state so a settings-change or 401-retry
// mid-flight can't clobber the newer cache/inflight.
let _apiKeyHelperCache: { value: string; timestamp: number } | null = null
let _apiKeyHelperInflight: {
  promise: Promise<string | null>
  // Only set on cold launches (user is waiting); null for SWR background refreshes.
  startedAt: number | null
} | null = null
let _apiKeyHelperEpoch = 0

export function getApiKeyHelperElapsedMs(): number {
  const startedAt = _apiKeyHelperInflight?.startedAt
  return startedAt ? Date.now() - startedAt : 0
}

export async function getApiKeyFromApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  if (!getConfiguredApiKeyHelper()) return null
  const ttl = calculateApiKeyHelperTTL()
  if (_apiKeyHelperCache) {
    if (Date.now() - _apiKeyHelperCache.timestamp < ttl) {
      return _apiKeyHelperCache.value
    }
    // Stale — return stale value now, refresh in the background.
    // `??=` banned here by eslint no-nullish-assign-object-call (bun bug).
    if (!_apiKeyHelperInflight) {
      _apiKeyHelperInflight = {
        promise: _runAndCache(
          isNonInteractiveSession,
          false,
          _apiKeyHelperEpoch,
        ),
        startedAt: null,
      }
    }
    return _apiKeyHelperCache.value
  }
  // Cold cache — deduplicate concurrent calls
  if (_apiKeyHelperInflight) return _apiKeyHelperInflight.promise
  _apiKeyHelperInflight = {
    promise: _runAndCache(isNonInteractiveSession, true, _apiKeyHelperEpoch),
    startedAt: Date.now(),
  }
  return _apiKeyHelperInflight.promise
}

async function _runAndCache(
  isNonInteractiveSession: boolean,
  isCold: boolean,
  epoch: number,
): Promise<string | null> {
  try {
    const value = await _executeApiKeyHelper(isNonInteractiveSession)
    if (epoch !== _apiKeyHelperEpoch) return value
    if (value !== null) {
      _apiKeyHelperCache = { value, timestamp: Date.now() }
    }
    return value
  } catch (e) {
    if (epoch !== _apiKeyHelperEpoch) return ' '
    const detail = e instanceof Error ? e.message : String(e)
    // biome-ignore lint/suspicious/noConsole: user-configured script failed; must be visible without --debug
    console.error(chalk.red(`apiKeyHelper failed: ${detail}`))
    logForDebugging(`Error getting API key from apiKeyHelper: ${detail}`, {
      level: 'error',
    })
    // SWR path: a transient failure shouldn't replace a working key with
    // the ' ' sentinel — keep serving the stale value and bump timestamp
    // so we don't hammer-retry every call.
    if (!isCold && _apiKeyHelperCache && _apiKeyHelperCache.value !== ' ') {
      _apiKeyHelperCache = { ..._apiKeyHelperCache, timestamp: Date.now() }
      return _apiKeyHelperCache.value
    }
    // Cold cache or prior error — cache ' ' so callers don't fall back to OAuth
    _apiKeyHelperCache = { value: ' ', timestamp: Date.now() }
    return ' '
  } finally {
    if (epoch === _apiKeyHelperEpoch) {
      _apiKeyHelperInflight = null
    }
  }
}

async function _executeApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return null
  }

  if (isApiKeyHelperFromProjectOrLocalSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !isNonInteractiveSession) {
      const error = new Error(
        `Security: apiKeyHelper executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('apiKeyHelper invoked before trust check', error)
      logEvent('tengu_apiKeyHelper_missing_trust11', {})
      return null
    }
  }

  const result = await execa(apiKeyHelper, {
    shell: true,
    timeout: 10 * 60 * 1000,
    reject: false,
  })
  if (result.failed) {
    // reject:false — execa resolves on exit≠0/timeout, stderr is on result
    const why = result.timedOut ? 'timed out' : `exited ${result.exitCode}`
    const stderr = result.stderr?.trim()
    throw new Error(stderr ? `${why}: ${stderr}` : why)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) {
    throw new Error('did not return a value')
  }
  return stdout
}

/**
 * Sync cache reader — returns the last fetched apiKeyHelper value without executing.
 * Returns stale values to match SWR semantics of the async reader.
 * Returns null only if the async fetch hasn't completed yet.
 */
export function getApiKeyFromApiKeyHelperCached(): string | null {
  return _apiKeyHelperCache?.value ?? null
}

export function clearApiKeyHelperCache(): void {
  _apiKeyHelperEpoch++
  _apiKeyHelperCache = null
  _apiKeyHelperInflight = null
}

export function prefetchApiKeyFromApiKeyHelperIfSafe(
  isNonInteractiveSession: boolean,
): void {
  // Skip if trust not yet accepted — the inner _executeApiKeyHelper check
  // would catch this too, but would fire a false-positive analytics event.
  if (
    isApiKeyHelperFromProjectOrLocalSettings() &&
    !checkHasTrustDialogAccepted()
  ) {
    return
  }
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}

/** Default STS credentials are one hour. We manually manage invalidation, so not too worried about this being accurate. */
const DEFAULT_AWS_STS_TTL = 60 * 60 * 1000

/**
 * Run awsAuthRefresh to perform interactive authentication (e.g., aws sso login)
 * Streams output in real-time for user visibility
 */
async function runAwsAuthRefresh(): Promise<boolean> {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()

  if (!awsAuthRefresh) {
    return false // Not configured, treat as success
  }

  // SECURITY: Check if awsAuthRefresh is from project settings
  if (isAwsAuthRefreshFromProjectSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsAuthRefresh invoked before trust check', error)
      logEvent('tengu_awsAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('Fetching AWS caller identity for AWS auth refresh command')
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS auth refresh command',
    )
    return false
  } catch {
    // only actually do the refresh if caller-identity calls
    return refreshAwsAuth(awsAuthRefresh)
  }
}

// Timeout for AWS auth refresh command (3 minutes).
// Long enough for browser-based SSO flows, short enough to prevent indefinite hangs.
const AWS_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

export function refreshAwsAuth(awsAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running AWS auth refresh command')
  // Start tracking authentication status
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(awsAuthRefresh, {
      timeout: AWS_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // Add output to status manager for UI display
        authStatusManager.addOutput(output)
        // Also log for debugging
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('AWS auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'AWS auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running awsAuthRefresh (in settings or ~/.local/share/codev/config.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * Run awsCredentialExport to get credentials and set environment variables
 * Expects JSON output containing AWS credentials
 */
async function getAwsCredsFromCredentialExport(): Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
} | null> {
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsCredentialExport) {
    return null
  }

  // SECURITY: Check if awsCredentialExport is from project settings
  if (isAwsCredentialExportFromProjectSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsCredentialExport executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsCredentialExport invoked before trust check', error)
      logEvent('tengu_awsCredentialExport_missing_trust', {})
      return null
    }
  }

  try {
    logForDebugging(
      'Fetching AWS caller identity for credential export command',
    )
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS credential export command',
    )
    return null
  } catch {
    // only actually do the export if caller-identity calls
    try {
      logForDebugging('Running AWS credential export command')
      const result = await execa(awsCredentialExport, {
        shell: true,
        reject: false,
      })
      if (result.exitCode !== 0 || !result.stdout) {
        throw new Error('awsCredentialExport did not return a valid value')
      }

      // Parse the JSON output from aws sts commands
      const awsOutput = jsonParse(result.stdout.trim())

      if (!isValidAwsStsOutput(awsOutput)) {
        throw new Error(
          'awsCredentialExport did not return valid AWS STS output structure',
        )
      }

      logForDebugging('AWS credentials retrieved from awsCredentialExport')
      return {
        accessKeyId: awsOutput.Credentials.AccessKeyId,
        secretAccessKey: awsOutput.Credentials.SecretAccessKey,
        sessionToken: awsOutput.Credentials.SessionToken,
      }
    } catch (e) {
      const message = chalk.red(
        'Error getting AWS credentials from awsCredentialExport (in settings or ~/.local/share/codev/config.json):',
      )
      if (e instanceof Error) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e.message)
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e)
      }
      return null
    }
  }
}

/**
 * Refresh AWS authentication and get credentials with cache clearing
 * This combines runAwsAuthRefresh, getAwsCredsFromCredentialExport, and clearAwsIniCache
 * to ensure fresh credentials are always used
 */
export const refreshAndGetAwsCredentials = memoizeWithTTLAsync(
  async (): Promise<{
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
  } | null> => {
    // First run auth refresh if needed
    const refreshed = await runAwsAuthRefresh()

    // Get credentials from export
    const credentials = await getAwsCredsFromCredentialExport()

    // Clear AWS INI cache to ensure fresh credentials are used
    if (refreshed || credentials) {
      await clearAwsIniCache()
    }

    return credentials
  },
  DEFAULT_AWS_STS_TTL,
)

export function clearAwsCredentialsCache(): void {
  refreshAndGetAwsCredentials.cache.clear()
}

/**
 * Get the configured gcpAuthRefresh from settings
 */
function getConfiguredGcpAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.gcpAuthRefresh
}

/**
 * Check if the configured gcpAuthRefresh comes from project settings
 */
export function isGcpAuthRefreshFromProjectSettings(): boolean {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()
  if (!gcpAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.gcpAuthRefresh === gcpAuthRefresh ||
    localSettings?.gcpAuthRefresh === gcpAuthRefresh
  )
}

/** Short timeout for the GCP credentials probe. Without this, when no local
 *  credential source exists (no ADC file, no env var), google-auth-library falls
 *  through to the GCE metadata server which hangs ~12s outside GCP. */
const GCP_CREDENTIALS_CHECK_TIMEOUT_MS = 5_000

/**
 * Check if GCP credentials are currently valid by attempting to get an access token.
 * This uses the same authentication chain that the Vertex SDK uses.
 */
export async function checkGcpCredentialsValid(): Promise<boolean> {
  try {
    // Dynamically import to avoid loading google-auth-library unnecessarily
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const probe = (async () => {
      const client = await auth.getClient()
      await client.getAccessToken()
    })()
    const timeout = sleep(GCP_CREDENTIALS_CHECK_TIMEOUT_MS).then(() => {
      throw new GcpCredentialsTimeoutError('GCP credentials check timed out')
    })
    await Promise.race([probe, timeout])
    return true
  } catch {
    return false
  }
}

/** Default GCP credential TTL - 1 hour to match typical ADC token lifetime */
const DEFAULT_GCP_CREDENTIAL_TTL = 60 * 60 * 1000

/**
 * Run gcpAuthRefresh to perform interactive authentication (e.g., gcloud auth application-default login)
 * Streams output in real-time for user visibility
 */
async function runGcpAuthRefresh(): Promise<boolean> {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return false // Not configured, treat as success
  }

  // SECURITY: Check if gcpAuthRefresh is from project settings
  if (isGcpAuthRefreshFromProjectSettings()) {
    // Check if trust has been established for this project
    // Pass true to indicate this is a dangerous feature that requires trust
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: gcpAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('gcpAuthRefresh invoked before trust check', error)
      logEvent('tengu_gcpAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('Checking GCP credentials validity for auth refresh')
    const isValid = await checkGcpCredentialsValid()
    if (isValid) {
      logForDebugging(
        'GCP credentials are valid, skipping auth refresh command',
      )
      return false
    }
  } catch {
    // Credentials check failed, proceed with refresh
  }

  return refreshGcpAuth(gcpAuthRefresh)
}

// Timeout for GCP auth refresh command (3 minutes).
// Long enough for browser-based auth flows, short enough to prevent indefinite hangs.
const GCP_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

export function refreshGcpAuth(gcpAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running GCP auth refresh command')
  // Start tracking authentication status. AwsAuthStatusManager is cloud-provider-agnostic
  // despite the name — print.ts emits its updates as generic SDK 'auth_status' messages.
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(gcpAuthRefresh, {
      timeout: GCP_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // Add output to status manager for UI display
        authStatusManager.addOutput(output)
        // Also log for debugging
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('GCP auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'GCP auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running gcpAuthRefresh (in settings or ~/.local/share/codev/config.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * Refresh GCP authentication if needed.
 * This function checks if credentials are valid and runs the refresh command if not.
 * Memoized with TTL to avoid excessive refresh attempts.
 */
export const refreshGcpCredentialsIfNeeded = memoizeWithTTLAsync(
  async (): Promise<boolean> => {
    // Run auth refresh if needed
    const refreshed = await runGcpAuthRefresh()
    return refreshed
  },
  DEFAULT_GCP_CREDENTIAL_TTL,
)

export function clearGcpCredentialsCache(): void {
  refreshGcpCredentialsIfNeeded.cache.clear()
}

/**
 * Prefetches GCP credentials only if workspace trust has already been established.
 * This allows us to start the potentially slow GCP commands early for trusted workspaces
 * while maintaining security for untrusted ones.
 *
 * Returns void to prevent misuse - use refreshGcpCredentialsIfNeeded() to actually refresh.
 */
export function prefetchGcpCredentialsIfSafe(): void {
  // Check if gcpAuthRefresh is configured
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return
  }

  // Check if gcpAuthRefresh is from project settings
  if (isGcpAuthRefreshFromProjectSettings()) {
    // Only prefetch if trust has already been established
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // Don't prefetch - wait for trust to be established first
      return
    }
  }

  // Safe to prefetch - either not from project settings or trust already established
  void refreshGcpCredentialsIfNeeded()
}

/**
 * Prefetches AWS credentials only if workspace trust has already been established.
 * This allows us to start the potentially slow AWS commands early for trusted workspaces
 * while maintaining security for untrusted ones.
 *
 * Returns void to prevent misuse - use refreshAndGetAwsCredentials() to actually retrieve credentials.
 */
export function prefetchAwsCredentialsAndBedRockInfoIfSafe(): void {
  // Check if either AWS command is configured
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsAuthRefresh && !awsCredentialExport) {
    return
  }

  // Check if either command is from project settings
  if (
    isAwsAuthRefreshFromProjectSettings() ||
    isAwsCredentialExportFromProjectSettings()
  ) {
    // Only prefetch if trust has already been established
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // Don't prefetch - wait for trust to be established first
      return
    }
  }

  // Safe to prefetch - either not from project settings or trust already established
  void refreshAndGetAwsCredentials()
  getModelStrings()
}

/** @private Use {@link getAnthropicApiKey} or {@link getAnthropicApiKeyWithSource} */
export const getApiKeyFromConfigOrMacOSKeychain = memoize(
  (): { key: string; source: ApiKeySource } | null => {
    if (isBareMode()) return null
    // TODO: migrate to SecureStorage
    if (process.platform === 'darwin') {
      // keychainPrefetch.ts fires this read at main.tsx top-level in parallel
      // with module imports. If it completed, use that instead of spawning a
      // sync `security` subprocess here (~33ms).
      const prefetch = getLegacyApiKeyPrefetchResult()
      if (prefetch) {
        if (prefetch.stdout) {
          return { key: prefetch.stdout, source: '/login managed key' }
        }
        // Prefetch completed with no key — fall through to config, not keychain.
      } else {
        const storageServiceName = getMacOsKeychainStorageServiceName()
        try {
          // Argv form (no shell): `$USER` and the service name must not be able
          // to inject shell metacharacters.
          const { stdout, exitCode } = execaSync(
            'security',
            [
              'find-generic-password',
              '-a',
              getUsername(),
              '-w',
              '-s',
              storageServiceName,
            ],
            { reject: false, stdio: ['ignore', 'pipe', 'ignore'] },
          )
          const result = exitCode === 0 ? stdout.trim() : ''
          if (result) {
            return { key: result, source: '/login managed key' }
          }
        } catch (e) {
          logError(e)
        }
      }
    }

    const config = getGlobalConfig()
    if (!config.primaryApiKey) {
      return null
    }

    return { key: config.primaryApiKey, source: '/login managed key' }
  },
)


export async function saveApiKey(apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  // Store as primary API key
  await maybeRemoveApiKeyFromMacOSKeychain()
  let savedToKeychain = false
  if (process.platform === 'darwin') {
    try {
      // TODO: migrate to SecureStorage
      const storageServiceName = getMacOsKeychainStorageServiceName()
      const username = getUsername()

      // Convert to hexadecimal to avoid any escaping issues
      const hexValue = Buffer.from(apiKey, 'utf-8').toString('hex')

      // Use security's interactive mode (-i) with -X (hexadecimal) option
      // This ensures credentials never appear in process command-line arguments
      // Process monitors only see "security -i", not the password
      const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`

      await execa('security', ['-i'], {
        input: command,
        reject: false,
      })

      logEvent('tengu_api_key_saved_to_keychain', {})
      savedToKeychain = true
    } catch (e) {
      logError(e)
      logEvent('tengu_api_key_keychain_error', {
        error: errorMessage(
          e,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logEvent('tengu_api_key_saved_to_config', {})
    }
  } else {
    logEvent('tengu_api_key_saved_to_config', {})
  }

  const normalizedKey = normalizeApiKeyForConfig(apiKey)

  // Save config with all updates
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? []
    return {
      ...current,
      // Only save to config if keychain save failed or not on darwin
      primaryApiKey: savedToKeychain ? current.primaryApiKey : apiKey,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: approved.includes(normalizedKey)
          ? approved
          : [...approved, normalizedKey],
        rejected: current.customApiKeyResponses?.rejected ?? [],
      },
    }
  })

  // Clear memo cache
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

export function isCustomApiKeyApproved(apiKey: string): boolean {
  const config = getGlobalConfig()
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  return (
    config.customApiKeyResponses?.approved?.includes(normalizedKey) ?? false
  )
}

export async function removeApiKey(): Promise<void> {
  await maybeRemoveApiKeyFromMacOSKeychain()

  // Also remove from config instead of returning early, for older clients
  // that set keys before we supported keychain.
  saveGlobalConfig(current => ({
    ...current,
    primaryApiKey: undefined,
  }))

  // Clear memo cache
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

async function maybeRemoveApiKeyFromMacOSKeychain(): Promise<void> {
  try {
    await maybeRemoveApiKeyFromMacOSKeychainThrows()
  } catch (e) {
    logError(e)
  }
}

// Claude account OAuth is disabled. Inference and model discovery are handled by 9router.
export function saveOAuthTokensIfNeeded(_tokens: OAuthTokens): { success: boolean } {
  return { success: false }
}

export const getClaudeAIOAuthTokens = memoize((): OAuthTokens | null => null)

export function clearOAuthTokenCache(): void {
  getClaudeAIOAuthTokens.cache?.clear?.()
}

export function handleOAuth401Error(_failedAccessToken: string): Promise<boolean> {
  return Promise.resolve(false)
}

export async function getClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null> {
  return null
}

export function checkAndRefreshOAuthTokenIfNeeded(
  _retryCount = 0,
  _force = false,
): Promise<boolean> {
  return Promise.resolve(false)
}

export function isClaudeAISubscriber(): boolean {
  // Model inference is delegated to 9router; local Claude subscriptions do
  // not gate models, commands, quota state, or fallback behavior anymore.
  return false
}

/**
 * Check if the current OAuth token has the user:profile scope.
 *
 * Real /login tokens always include this scope. Env-var and file-descriptor
 * tokens (service keys) hardcode scopes to ['user:inference'] only. Use this
 * to gate calls to profile-scoped endpoints so service key sessions don't
 * generate 403 storms against /api/oauth/profile, bootstrap, etc.
 */
export function hasProfileScope(): boolean {
  return false
}

export function is1PApiCustomer(): boolean {
  // 1P API customers are users who are NOT:
  // 1. Claude.ai subscribers (Max, Pro, Enterprise, Team)
  // 2. Vertex AI users
  // 3. AWS Bedrock users
  // 4. Foundry users

  // Exclude Vertex, Bedrock, and Foundry customers
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return false
  }

  // Exclude Claude.ai subscribers
  if (isClaudeAISubscriber()) {
    return false
  }

  // Everyone else is an API customer (OAuth API customers, direct API key users, etc.)
  return true
}

/**
 * Gets OAuth account information when Anthropic auth is enabled.
 * Returns undefined when using external API keys or third-party services.
 */
export function getOauthAccountInfo(): AccountInfo | undefined {
  return undefined
}

/**
 * Checks if overage/extra usage provisioning is allowed for this organization.
 * This mirrors the logic in apps/claude-ai `useIsOverageProvisioningAllowed` hook as closely as possible.
 */
export function isOverageProvisioningAllowed(): boolean {
  const accountInfo = getOauthAccountInfo()
  const billingType = accountInfo?.billingType

  // Must be a Claude subscriber with a supported subscription type
  if (!isClaudeAISubscriber() || !billingType) {
    return false
  }

  // only allow Stripe and mobile billing types to purchase extra usage
  if (
    billingType !== 'stripe_subscription' &&
    billingType !== 'stripe_subscription_contracted' &&
    billingType !== 'apple_subscription' &&
    billingType !== 'google_play_subscription'
  ) {
    return false
  }

  return true
}

// Returns whether the user has Opus access at all, regardless of whether they
// are a subscriber or PayG.
export function hasOpusAccess(): boolean {
  const subscriptionType = getSubscriptionType()

  return (
    subscriptionType === 'max' ||
    subscriptionType === 'enterprise' ||
    subscriptionType === 'team' ||
    subscriptionType === 'pro' ||
    // subscriptionType === null covers both API users and the case where
    // subscribers do not have subscription type populated. For those
    // subscribers, when in doubt, we should not limit their access to Opus.
    subscriptionType === null
  )
}

export function getSubscriptionType(): SubscriptionType | null {
  // Check for mock subscription type first (ANT-only testing)
  if (shouldUseMockSubscription()) {
    return getMockSubscriptionType()
  }

  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.subscriptionType ?? null
}

export function isMaxSubscriber(): boolean {
  return getSubscriptionType() === 'max'
}

export function isTeamSubscriber(): boolean {
  return getSubscriptionType() === 'team'
}

export function isTeamPremiumSubscriber(): boolean {
  return (
    getSubscriptionType() === 'team' &&
    getRateLimitTier() === 'default_claude_max_5x'
  )
}

export function isEnterpriseSubscriber(): boolean {
  return getSubscriptionType() === 'enterprise'
}

export function isProSubscriber(): boolean {
  return getSubscriptionType() === 'pro'
}

export function getRateLimitTier(): string | null {
  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.rateLimitTier ?? null
}

export function getSubscriptionName(): string {
  const subscriptionType = getSubscriptionType()

  switch (subscriptionType) {
    case 'enterprise':
      return 'Claude Enterprise'
    case 'team':
      return 'Claude Team'
    case 'max':
      return 'Claude Max'
    case 'pro':
      return 'Claude Pro'
    default:
      return 'Claude API'
  }
}

/** Check if using third-party services (Bedrock or Vertex or Foundry) */
export function isUsing3PServices(): boolean {
  return !!(
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  )
}

/**
 * Check if the user has an active OpenAI OAuth login.
 * Returns false when no OpenAI tokens are configured.
 */
export function hasOpenAIAuthLogin(): boolean {
  return false
}

/**
 * Get the configured otelHeadersHelper from settings
 */
function getConfiguredOtelHeadersHelper(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.otelHeadersHelper
}

/**
 * Check if the configured otelHeadersHelper comes from project settings (projectSettings or localSettings)
 */
export function isOtelHeadersHelperFromProjectOrLocalSettings(): boolean {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()
  if (!otelHeadersHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.otelHeadersHelper === otelHeadersHelper ||
    localSettings?.otelHeadersHelper === otelHeadersHelper
  )
}

// Cache for debouncing otelHeadersHelper calls
let cachedOtelHeaders: Record<string, string> | null = null
let cachedOtelHeadersTimestamp = 0
const DEFAULT_OTEL_HEADERS_DEBOUNCE_MS = 29 * 60 * 1000 // 29 minutes

export function getOtelHeadersFromHelper(): Record<string, string> {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()

  if (!otelHeadersHelper) {
    return {}
  }

  // Return cached headers if still valid (debounce)
  const debounceMs = parseInt(
    process.env.CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS ||
      DEFAULT_OTEL_HEADERS_DEBOUNCE_MS.toString(),
  )
  if (
    cachedOtelHeaders &&
    Date.now() - cachedOtelHeadersTimestamp < debounceMs
  ) {
    return cachedOtelHeaders
  }

  if (isOtelHeadersHelperFromProjectOrLocalSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      return {}
    }
  }

  try {
    const result = execSyncWithDefaults_DEPRECATED(otelHeadersHelper, {
      timeout: 30000, // 30 seconds - allows for auth service latency
    })
      ?.toString()
      .trim()
    if (!result) {
      throw new Error('otelHeadersHelper did not return a valid value')
    }

    const headers = jsonParse(result)
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new Error(
        'otelHeadersHelper must return a JSON object with string key-value pairs',
      )
    }

    // Validate all values are strings
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new Error(
          `otelHeadersHelper returned non-string value for key "${key}": ${typeof value}`,
        )
      }
    }

    // Cache the result
    cachedOtelHeaders = headers as Record<string, string>
    cachedOtelHeadersTimestamp = Date.now()

    return cachedOtelHeaders
  } catch (error) {
    logError(
      new Error(
        `Error getting OpenTelemetry headers from otelHeadersHelper (in settings): ${errorMessage(error)}`,
      ),
    )
    throw error
  }
}

function isConsumerPlan(plan: SubscriptionType): plan is 'max' | 'pro' {
  return plan === 'max' || plan === 'pro'
}

export function isConsumerSubscriber(): boolean {
  const subscriptionType = getSubscriptionType()
  return (
    isClaudeAISubscriber() &&
    subscriptionType !== null &&
    isConsumerPlan(subscriptionType)
  )
}

export type UserAccountInfo = {
  subscription?: string
  tokenSource?: string
  apiKeySource?: ApiKeySource
  organization?: string
  email?: string
}

export function getAccountInformation() {
  const apiProvider = getAPIProvider()
  // Only provide account info for first-party Anthropic API
  if (apiProvider !== 'firstParty') {
    return undefined
  }
  const { source: authTokenSource } = getAuthTokenSource()
  const accountInfo: UserAccountInfo = {}
  if (authTokenSource !== 'none') {
    accountInfo.tokenSource = authTokenSource
  }
  const { key: apiKey, source: apiKeySource } = getAnthropicApiKeyWithSource()
  if (apiKey) {
    accountInfo.apiKeySource = apiKeySource
  }
  return accountInfo
}

class GcpCredentialsTimeoutError extends Error {}
