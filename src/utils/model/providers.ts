import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getGlobalConfigSnapshot } from '../config.js'

export type APIProvider =
  | 'firstParty'
  | 'openrouter'
  | 'openai'
  | 'local'
  | 'opencode'
  | 'nvidia'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'kiro'
  | 'custom'

/** Legacy provider IDs retained for compatibility with pinned agents. */
export const API_PROVIDERS: readonly APIProvider[] = [
  'firstParty',
  'openrouter',
  'openai',
  'local',
  'opencode',
  'nvidia',
  'bedrock',
  'vertex',
  'foundry',
  'kiro',
  'custom',
]

export function isAPIProvider(value: string): value is APIProvider {
  return (API_PROVIDERS as readonly string[]).includes(value)
}

let storedProviderCache: APIProvider | null | undefined = undefined

function getStoredProviderPreference(): APIProvider | null {
  if (storedProviderCache !== undefined) {
    return storedProviderCache
  }

  try {
    const config = getGlobalConfigSnapshot()

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
      case 'nvidia':
        result = config.nvidiaApiKey ? 'nvidia' : null
        break
      case 'kiro':
        result = config.kiroAccessToken ? 'kiro' : null
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
    case 'nvidia':
      return 'nvidia'
    case 'bedrock':
      return 'bedrock'
    case 'vertex':
      return 'vertex'
    case 'foundry':
      return 'foundry'
    case 'kiro':
      return 'kiro'
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

export function isNvidiaConfigured(): boolean {
  if (getExplicitProviderOverride() === 'nvidia' || Boolean(process.env.NVIDIA_API_KEY)) {
    return true
  }

  // Check config file
  return getStoredProviderPreference() === 'nvidia'
}

export function getNvidiaBaseUrl(): string {
  return process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1'
}

export function isKiroConfigured(): boolean {
  if (getExplicitProviderOverride() === 'kiro') {
    return true
  }
  return getStoredProviderPreference() === 'kiro'
}

export function getKiroBaseUrl(): string {
  return process.env.KIRO_BASE_URL ?? 'https://q.us-east-1.amazonaws.com'
}

export function getKiroRegion(): string {
  return process.env.KIRO_REGION ?? 'us-east-1'
}

export function getKiroInferenceBaseUrl(): string {
  return process.env.KIRO_BASE_URL ?? 'http://localhost:8080'
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

export function isLocalConfigured(): boolean {
  if (getExplicitProviderOverride() === 'local') {
    return true
  }

  return getStoredProviderPreference() === 'local'
}

export function getOpencodeBaseUrl(): string {
  return process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/inference/v1'
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
  // Custom OpenAI-compatible endpoint takes precedence over 9router.
  const custom = getCustomBaseUrl()
  if (custom) return custom
  return process.env.NINE_ROUTER_BASE_URL ?? 'http://localhost:20128/v1'
}

/**
 * Env overrides for the custom (OpenAI-compatible) endpoint.
 *
 * These let a headless runner point codev at an arbitrary gateway without
 * touching the on-disk config: e.g. an RL-training harness exporting
 * ``CODEV_BASE_URL``/``CODEV_API_KEY``/``CODEV_MODEL`` into the sandbox.
 *
 * Priority: ``CODEV_*`` (explicit per-run override) > stored config >
 * ``OPENAI_*`` (generic fallback).
 */
const CUSTOM_BASE_URL_ENV_VARS = ['CODEV_BASE_URL', 'OPENAI_BASE_URL'] as const
const CUSTOM_API_KEY_ENV_VARS = ['CODEV_API_KEY', 'OPENAI_API_KEY'] as const
const CUSTOM_MODEL_ENV_VARS = ['CODEV_MODEL', 'OPENAI_MODEL'] as const

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

export function getEnvCustomBaseUrl(): string | undefined {
  return firstEnv(CUSTOM_BASE_URL_ENV_VARS)
}

export function getEnvCustomApiKey(): string | undefined {
  return firstEnv(CUSTOM_API_KEY_ENV_VARS)
}

export function getEnvCustomModel(): string | undefined {
  return firstEnv(CUSTOM_MODEL_ENV_VARS)
}

/** ``CODEV_*`` only — the explicit per-run override. */
export function getCodevEnvBaseUrl(): string | undefined {
  return process.env.CODEV_BASE_URL?.trim() || undefined
}

export function getCodevEnvApiKey(): string | undefined {
  return process.env.CODEV_API_KEY?.trim() || undefined
}

export function getCodevEnvModel(): string | undefined {
  return process.env.CODEV_MODEL?.trim() || undefined
}

export interface CustomEndpoint {
  id: string
  baseUrl: string
  apiKey?: string
  modelName?: string
}

export function getCustomEndpoints(): CustomEndpoint[] {
  try {
    const config = getGlobalConfigSnapshot()
    if (config.customEndpoints?.length) return config.customEndpoints
  } catch {
    // Ignore
  }
  // Legacy single-endpoint fallback: treat it as a single-entry list
  try {
    const config = getGlobalConfigSnapshot()
    if (config.customBaseUrl) {
      return [{
        id: 'legacy',
        baseUrl: config.customBaseUrl,
        apiKey: config.customApiKey,
        modelName: config.customModelName,
      }]
    }
  } catch {
    // Ignore
  }
  return []
}

export function getCustomBaseUrl(): string | undefined {
  const override = getCodevEnvBaseUrl()
  if (override) return override
  const endpoints = getCustomEndpoints()
  const idx = (getGlobalConfigSnapshot().currentCustomEndpointIndex ?? 0)
  if (endpoints[idx]?.baseUrl) return endpoints[idx].baseUrl
  return getEnvCustomBaseUrl()
}

export function isCustomConfigured(): boolean {
  if (getCodevEnvBaseUrl()) return true
  if (getCustomEndpoints().length > 0) return true
  // Fallback to generic OPENAI_* env vars
  return Boolean(getEnvCustomBaseUrl())
}

export function getCustomApiConfig(): { baseUrl: string | null; modelName: string | null; apiKey: string | null } {
  const override = getCodevEnvBaseUrl()
  if (override) {
    return {
      baseUrl: override,
      modelName: getCodevEnvModel() ?? null,
      apiKey: getCodevEnvApiKey() ?? null,
    }
  }
  try {
    const config = getGlobalConfigSnapshot()
    const endpoints = config.customEndpoints ?? []
    const idx = config.currentCustomEndpointIndex ?? 0
    const ep = endpoints[idx]
    if (ep?.baseUrl) {
      return { baseUrl: ep.baseUrl, modelName: ep.modelName ?? null, apiKey: ep.apiKey ?? null }
    }
  } catch {
    // Ignore
  }
  return { baseUrl: null, modelName: null, apiKey: null }
}

/**
 * Model name for the currently active custom endpoint.
 *
 * Priority: ``CODEV_MODEL`` > active endpoint's ``modelName`` > legacy ``customModelName`` > ``OPENAI_MODEL``.
 */
export function getCustomModelName(): string | undefined {
  const override = getCodevEnvModel()
  if (override) return override
  const config = getGlobalConfigSnapshot()
  const endpoints = config.customEndpoints ?? []
  const idx = config.currentCustomEndpointIndex ?? 0
  if (endpoints[idx]?.modelName) return endpoints[idx].modelName
  if (config.customModelName) return config.customModelName
  return getEnvCustomModel()
}

export function getAPIProvider(): APIProvider | null {
  // 9router is the default gateway; custom endpoint overrides it.
  if (isCustomConfigured()) return 'custom'
  return 'openai'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

export function isAnthropicCompatibleProvider(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return provider !== 'openai' && provider !== 'opencode' && provider !== 'nvidia' && provider !== 'kiro' && provider !== 'custom'
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
