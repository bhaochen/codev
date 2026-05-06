import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'
import { getGlobalClaudeFile } from '../env.js'

export type APIProvider =
  | 'firstParty'
  | 'openrouter'
  | 'openai'
  | 'local'
  | 'opencode'
  | 'bedrock'
  | 'vertex'
  | 'foundry'

let storedProviderCache: APIProvider | null | undefined = undefined

function getStoredProviderPreference(): APIProvider | null {
  if (storedProviderCache !== undefined) {
    return storedProviderCache
  }

  try {
    // Read the global config file directly so provider selection works even
    // before the guarded config loader is enabled during startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('fs') as typeof import('fs')
    const raw = readFileSync(getGlobalClaudeFile(), 'utf8')
    const config = JSON.parse(raw) as {
      authProvider?: 'anthropic' | 'openrouter' | 'openai' | 'local' | 'opencode'
      openRouterApiKey?: string
      openAiApiKey?: string
      openAiAccessToken?: string
      localBaseUrl?: string
      localModelName?: string
      openCodeApiKey?: string
      openCodeModelName?: string
    }

    let result: APIProvider | null
    switch (config.authProvider) {
      case 'openrouter':
        result = config.openRouterApiKey ? 'openrouter' : null
        break
      case 'openai':
        result =
          config.openAiApiKey || config.openAiAccessToken
            ? 'openai'
            : null
        break
      case 'local':
        result = config.localBaseUrl ? 'local' : null
        break
      case 'opencode':
        result = 'opencode'
        break
      case 'anthropic':
        result = 'firstParty'
        break
      default:
        result = null
    }

    storedProviderCache = result
    return result
  } catch {
    storedProviderCache = null
    return null
  }
}

export function clearStoredProviderCache(): void {
  storedProviderCache = undefined
}

function getExplicitProviderOverride(): APIProvider | null {
  const rawProvider =
    process.env.BETTER_CLAWD_API_PROVIDER ??
    process.env.CLAUDE_CODE_API_PROVIDER
  switch (rawProvider?.toLowerCase()) {
    case 'anthropic':
    case 'firstparty':
    case 'first_party':
    case 'first-party':
      return 'firstParty'
    case 'openrouter':
      return 'openrouter'
    case 'openai':
      return 'openai'
    case 'local':
      return 'local'
    case 'opencode':
      return 'opencode'
    case 'bedrock':
      return 'bedrock'
    case 'vertex':
      return 'vertex'
    case 'foundry':
      return 'foundry'
    default:
      return null
  }
}

export function isOpenRouterBaseUrl(baseUrl?: string | null): boolean {
  if (!baseUrl) {
    return false
  }
  try {
    return new URL(baseUrl).host === 'openrouter.ai'
  } catch {
    return false
  }
}

export function isOpenRouterConfigured(): boolean {
  if (
    getExplicitProviderOverride() === 'openrouter' ||
    Boolean(process.env.OPENROUTER_API_KEY) ||
    isOpenRouterBaseUrl(process.env.OPENROUTER_BASE_URL) ||
    isOpenRouterBaseUrl(process.env.ANTHROPIC_BASE_URL)
  ) {
    return true
  }

  // Check config file
  return getStoredProviderPreference() === 'openrouter'
}

export function isOpenAIConfigured(): boolean {
  if (
    getExplicitProviderOverride() === 'openai' ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.OPENAI_BASE_URL) ||
    Boolean(process.env.OPENAI_ACCESS_TOKEN) ||
    Boolean(process.env.CODEX_ACCESS_TOKEN)
  ) {
    return true
  }

  // Check config file
  return getStoredProviderPreference() === 'openai'
}

export function isOpencodeConfigured(): boolean {
  if (getExplicitProviderOverride() === 'opencode') {
    return true
  }

  // Check config file
  return getStoredProviderPreference() === 'opencode'
}

export function getOpencodeBaseUrl(): string {
  return process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/zen/v1'
}

export function getOpenRouterBaseUrl(): string {
  const configuredBaseUrl = process.env.OPENROUTER_BASE_URL
  const fallbackBaseUrl = 'https://openrouter.ai/api'
  if (!configuredBaseUrl) {
    return fallbackBaseUrl
  }

  try {
    const url = new URL(configuredBaseUrl)

    if (url.host === 'openrouter.ai') {
      const normalizedPath = url.pathname.replace(/\/+$/, '')
      if (normalizedPath === '' || normalizedPath === '/') {
        url.pathname = '/api'
      } else if (normalizedPath === '/api/v1') {
        // Anthropic SDK appends /v1/messages itself, so OpenRouter's SDK base
        // must stop at /api rather than /api/v1.
        url.pathname = '/api'
      }
    }

    return url.toString().replace(/\/$/, '')
  } catch {
    return configuredBaseUrl
  }
}

export function getOpenAIBaseUrl(): string {
  return process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
}

export function getAPIProvider(): APIProvider | null {
  const explicitProvider = getExplicitProviderOverride()
  if (explicitProvider) {
    return explicitProvider
  }

  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : isOpencodeConfigured()
          ? 'opencode'
          : isOpenAIConfigured()
            ? 'openai'
            : isOpenRouterConfigured()
              ? 'openrouter'
              : getStoredProviderPreference()
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

export function isAnthropicCompatibleProvider(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return provider !== 'openai' && provider !== 'opencode'
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
