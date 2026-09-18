import { getNvidiaApiKey } from '../auth.js'
import { getNvidiaBaseUrl } from './providers.js'

const MODELS_META_URL = 'https://models.dev/api.json'

type CachedNvidiaModel = {
  id: string
  contextWindow?: number
  maxTokens?: number
  reasoningOptions?: string[]
}

let cachedNvidiaModels: CachedNvidiaModel[] | null = null
let fetchPromise: Promise<string[]> | null = null

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function chatCompletionsUrl(base: string): string {
  const b = normalizeBaseUrl(base)
  if (b.endsWith('/v1')) {
    return `${b}/chat/completions`
  }
  return `${b}/v1/chat/completions`
}

export function getCachedNvidiaModels(): CachedNvidiaModel[] {
  return cachedNvidiaModels || []
}

export function getNvidiaModelContextWindow(modelId: string): number | undefined {
  if (!cachedNvidiaModels) return undefined
  const model = cachedNvidiaModels.find(m => m.id === modelId)
  return model?.contextWindow
}

export function getNvidiaModelReasoningOptions(modelId: string): string[] | undefined {
  if (!cachedNvidiaModels) return undefined
  const model = cachedNvidiaModels.find(m => m.id === modelId)
  return model?.reasoningOptions
}

/**
 * Fetch available models from the NVIDIA API catalog and merge context windows
 * from the models.dev API (which provides limit.context for NVIDIA models).
 */
export async function fetchNvidiaModels(apiKey?: string): Promise<string[]> {
  if (fetchPromise) return []

  fetchPromise = (async () => {
    const baseUrl = getNvidiaBaseUrl()
    const key = apiKey || getNvidiaApiKey()
    const normalizedBase = baseUrl.replace(/\/$/, '')
    const modelsUrl = normalizedBase.endsWith('/v1')
      ? `${normalizedBase}/models`
      : `${normalizedBase}/v1/models`

    const headers: Record<string, string> = {}
    if (key) {
      headers.Authorization = `Bearer ${key}`
    }

    // Fetch NVIDIA model IDs from the provider's own API
    // Note: this API only returns { id, object, created, owned_by } — no context window
    let modelIds: string[] = []
    try {
      const res = await fetch(
        normalizedBase.endsWith('/v1')
          ? `${baseUrl.replace(/\/$/, '')}/models`
          : `${baseUrl.replace(/\/$/, '')}/v1/models`,
        { headers, signal: AbortSignal.timeout(20_000) }
      )
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ id: string }> }
        if (json.data && Array.isArray(json.data)) {
          modelIds = json.data.map((m: { id: string }) => m.id)
        }
      }
    } catch {
      // NVIDIA API unreachable — still try models.dev fallback below
    }

    // Fetch context windows from models.dev API (canonical source for context limits)
    const contextWindows = new Map<string, { contextWindow?: number; maxTokens?: number; reasoningOptions?: string[] }>()
    try {
      const metaRes = await fetch('https://models.dev/api.json', {
        headers: { 'User-Agent': 'opencode/1.15.6 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14' },
        signal: AbortSignal.timeout(15_000),
      })
      if (metaRes.ok) {
        const data = (await metaRes.json()) as any
        const nvidiaModels = data?.nvidia?.models || {}
        for (const [modelId, config] of Object.entries(nvidiaModels) as [string, any][]) {
          const reasoningOptions = config.reasoning_options?.find(
            (o: any) => o.type === 'effort',
          )?.values
          contextWindows.set(modelId, {
            contextWindow: config.limit?.context,
            maxTokens: config.limit?.output,
            reasoningOptions,
          })
        }
      }
    } catch {
      // models.dev unreachable — models will use fallback defaults
    }

    // Merge: model IDs from NVIDIA API + context windows from models.dev
    // If NVIDIA API call failed, fall back to the full model list from models.dev
    if (modelIds.length === 0) {
      modelIds = [...contextWindows.keys()]
    }

    cachedNvidiaModels = modelIds.map(id => ({
      id,
      contextWindow: contextWindows.get(id)?.contextWindow,
      maxTokens: contextWindows.get(id)?.maxTokens,
      reasoningOptions: contextWindows.get(id)?.reasoningOptions,
    }))

    return modelIds
  })()

  await fetchPromise
  return cachedNvidiaModels?.map(m => m.id) || []
}