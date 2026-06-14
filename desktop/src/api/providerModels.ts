/**
 * Direct provider model fetcher.
 *
 * Fetches available models directly from provider APIs, mirroring the logic
 * in TUI's openRouterModels.ts / nvidiaClient.ts / opencodeClient.ts.
 *
 * This bypasses the cc-haha sidecar's /api/models endpoint entirely,
 * reusing TUI's model acquisition approach in the desktop WebView.
 */

import { getTuiConfig } from './config'
import type { ModelInfo } from '../types/settings'

// ─── Type ────────────────────────────────────────────────────────────────────

type FetchResult = {
  models: ModelInfo[]
  provider: { id: string; name: string } | null
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let modelCache: { key: string; models: ModelInfo[] } | null = null
let cacheTime = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export function clearProviderModelCache(): void {
  modelCache = null
  cacheTime = 0
  orCache = null
  orCacheTime = 0
  nvCache = null
  nvCacheTime = 0
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function fetchProviderModels(): Promise<FetchResult> {
  const config = await getTuiConfig()
  const authProvider = (config.authProvider as string | undefined) || null

  const cacheKey = authProvider ?? '__default__'
  if (modelCache && modelCache.key === cacheKey && Date.now() - cacheTime < CACHE_TTL) {
    return { models: modelCache.models, provider: null }
  }

  let models: ModelInfo[] = []
  let providerInfo: { id: string; name: string } | null = null

  switch (authProvider) {
    case 'openrouter': {
      const apiKey = config.openRouterApiKey as string | undefined
      models = await fetchOpenRouterModels(apiKey)
      providerInfo = models.length > 0
        ? { id: 'cli-openrouter', name: 'OpenRouter' }
        : null
      break
    }

    case 'nvidia': {
      const apiKey = config.nvidiaApiKey as string | undefined
      const baseUrl = config.nvidiaBaseUrl as string | undefined
      models = await fetchNvidiaModels(apiKey, baseUrl || 'https://integrate.api.nvidia.com/v1')
      providerInfo = models.length > 0
        ? { id: 'cli-nvidia', name: 'NVIDIA' }
        : null
      break
    }

    case 'opencode': {
      models = await fetchOpencodeModels()
      providerInfo = models.length > 0
        ? { id: 'cli-opencode', name: 'OpenCode Zen' }
        : null
      break
    }

    case 'openai':
      // OpenAI models are best fetched via the official provider API.
      // For now, the static catalog from modelCatalog.ts is used.
      break

    case 'local': {
      const modelName = config.localModelName as string | undefined
      if (modelName) {
        models = [{ id: modelName, name: modelName, description: 'Local model', context: '' }]
      }
      providerInfo = { id: 'cli-local', name: 'Local' }
      break
    }

    default:
      // firstParty / anthropic — no external fetch, use static defaults
      break
  }

  modelCache = { key: cacheKey, models }
  cacheTime = Date.now()

  return { models, provider: providerInfo }
}

// ─── OpenRouter ──────────────────────────────────────────────────────────────

let orCache: ModelInfo[] | null = null
let orCacheTime = 0
const OR_CACHE_TTL = 5 * 60 * 1000

async function fetchOpenRouterModels(apiKey?: string | null): Promise<ModelInfo[]> {
  if (orCache && Date.now() - orCacheTime < OR_CACHE_TTL) {
    return orCache
  }

  if (!apiKey) {
    orCache = []
    orCacheTime = Date.now()
    return []
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      orCache = []
      return []
    }

    const data = (await res.json()) as { data?: Array<{ id: string; name: string; description?: string; context_length?: number }> }
    const models: ModelInfo[] = (data.data || [])
      .filter((m) => {
        const id = m.id.toLowerCase()
        return id.includes('/') && !id.startsWith('router') && !id.startsWith('free') && !id.startsWith('aggregat')
      })
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        description: (m.description || '').length > 100 ? m.description!.slice(0, 97) + '...' : (m.description || ''),
        context: String(m.context_length || ''),
      }))

    orCache = models
    orCacheTime = Date.now()
    return models
  } catch {
    orCache = orCache || []
    return orCache
  }
}

// ─── NVIDIA NIM ──────────────────────────────────────────────────────────────

let nvCache: ModelInfo[] | null = null
let nvCacheTime = 0

async function fetchNvidiaModels(apiKey?: string | null, baseUrl?: string): Promise<ModelInfo[]> {
  if (nvCache && Date.now() - nvCacheTime < OR_CACHE_TTL) {
    return nvCache
  }

  if (!apiKey) {
    nvCache = []
    nvCacheTime = Date.now()
    return []
  }

  const normalized = (baseUrl || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
  const modelsUrl = normalized.endsWith('/v1') ? `${normalized}/models` : `${normalized}/v1/models`

  try {
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      nvCache = []
      return []
    }

    const json = (await res.json()) as { data?: Array<{ id: string }> }
    if (json.data && Array.isArray(json.data)) {
      const models: ModelInfo[] = json.data.map((m) => ({
        id: m.id,
        name: m.id,
        description: 'NVIDIA NIM model',
        context: '',
      }))
      nvCache = models
      nvCacheTime = Date.now()
      return models
    }

    nvCache = []
    return []
  } catch {
    nvCache = nvCache || []
    return nvCache
  }
}

// ─── OpenCode Zen ────────────────────────────────────────────────────────────

export async function fetchOpencodeModels(): Promise<ModelInfo[]> {
  try {
    const res = await fetch('https://models.dev/api.json', {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []

    const data = (await res.json()) as {
      opencode?: { models?: Record<string, { name?: string; status?: string; cost?: { input?: number; output?: number } }> }
    }
    const opencodeModels = data?.opencode?.models || {}
    const models: ModelInfo[] = []

    for (const [modelId, cfg] of Object.entries(opencodeModels)) {
      if (cfg.status === 'deprecated') continue
      const isFree = cfg.cost?.input === 0 && cfg.cost?.output === 0
      models.push({
        id: modelId,
        name: cfg.name || modelId,
        description: isFree ? 'Free model' : 'Paid model',
        context: '',
      })
    }

    return models
  } catch {
    return []
  }
}
