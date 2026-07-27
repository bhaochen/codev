import type { ModelOption } from './modelOptions.js'

const MODELS_META_URL = 'https://models.dev/api.json'

type OpenRouterModelInfo = {
  id: string
  contextWindow?: number
  maxTokens?: number
  reasoningOptions?: string[]
}

let openRouterModelsCache: ModelOption[] | null = null
let openRouterModelInfos: Map<string, OpenRouterModelInfo> | null = null
let cacheTimestamp: number = 0
let isFetching = false
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

export interface OpenRouterModel {
  id: string
  name: string
  description: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
  }
}

function formatPrice(price: string): string {
  const numPrice = parseFloat(price)
  if (numPrice === 0) return 'Free'
  if (numPrice < 0.000001) return '$<0.000001'
  return `$${price}`
}

export async function fetchOpenRouterModels(
  apiKey?: string,
): Promise<ModelOption[]> {
  // Check cache
  if (
    openRouterModelsCache !== null &&
    Date.now() - cacheTimestamp < CACHE_DURATION
  ) {
    return openRouterModelsCache
  }

  // Prevent concurrent fetches
  if (isFetching) {
    return []
  }

  isFetching = true

  // Import auth utilities to get API key
  const { getGlobalConfig } = await import('../config.js')
  const config = getGlobalConfig()
  const key = apiKey || config.openRouterApiKey

  if (!key) {
    isFetching = false
    return []
  }

  try {
    // Fetch model list from OpenRouter API
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`)
    }

    const data = await response.json()
    const models: OpenRouterModel[] = data.data || []

    // Filter out non-model items (routers, aggregators, etc.)
    const validModels = models.filter(model => {
      const id = model.id.toLowerCase()
      const name = model.name.toLowerCase()

      // Skip items that are routers, aggregators, or services
      const skipPatterns = [
        'router',
        'aggregator',
        'aggregation',
        'free.*router',
        'routing',
        'service',
        'platform',
        'hub',
      ]

      // Skip if ID or name matches any skip pattern
      for (const pattern of skipPatterns) {
        if (new RegExp(pattern).test(id) || new RegExp(pattern).test(name)) {
          return false
        }
      }

      // Skip items without proper model ID format (should contain provider/model)
      if (!id.includes('/') || id.startsWith('router') || id.startsWith('free')) {
        return false
      }

      // Skip items without pricing information
      if (!model.pricing || !model.pricing.prompt || !model.pricing.completion) {
        return false
      }

      return true
    })

    // Convert to ModelOption format
    const options: ModelOption[] = validModels.map(model => ({
      value: model.id,
      label: model.name,
      description: (model.description || model.id).substring(0, 100),
    }))

    // Fetch context windows and reasoning options from models.dev
    const modelInfos = new Map<string, OpenRouterModelInfo>()
    try {
      const metaRes = await fetch(MODELS_META_URL, {
        headers: {
          'User-Agent': 'opencode/1.15.6 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (metaRes.ok) {
        const meta = await metaRes.json() as any
        const orModels = meta?.openrouter?.models || {}
        for (const [modelId, config] of Object.entries(orModels) as [string, any][]) {
          const reasoningOptions = config.reasoning_options?.find(
            (o: any) => o.type === 'effort',
          )?.values
          modelInfos.set(modelId, {
            id: modelId,
            contextWindow: config.limit?.context,
            maxTokens: config.limit?.output,
            reasoningOptions,
          })
        }
      }
    } catch {
      // models.dev unreachable — fall back to OpenRouter API context_length
    }

    // Merge: use OpenRouter API's context_length if models.dev has no entry
    for (const model of validModels) {
      if (!modelInfos.has(model.id)) {
        modelInfos.set(model.id, {
          id: model.id,
          contextWindow: model.context_length,
        })
      }
    }

    // Update caches
    openRouterModelsCache = options
    openRouterModelInfos = modelInfos
    cacheTimestamp = Date.now()

    return options
  } catch (error) {
    console.error('Failed to fetch OpenRouter models:', error)
    return []
  } finally {
    isFetching = false
  }
}

export function getCachedOpenRouterModels(): ModelOption[] {
  return openRouterModelsCache || []
}

export function hasOpenRouterModelsCache(): boolean {
  return openRouterModelsCache !== null
}

export function getFirstFreeModel(): ModelOption | null {
  if (!openRouterModelsCache || openRouterModelsCache.length === 0) {
    return null
  }

  return openRouterModelsCache.find(model => {
    // Check if this model is free by looking at the model name
    // Models with ":free" or "(free)" in the name are free
    const label = (model.label || '').toLowerCase()
    const value = (model.value || '').toLowerCase()
    return label.includes(':free') || label.includes('(free)') || value.includes(':free') || value.includes('(free)')
  }) || null
}

export function clearOpenRouterModelsCache(): void {
  openRouterModelsCache = null
  cacheTimestamp = 0
}

export function getOpenRouterModelContextWindow(modelId: string): number | undefined {
  if (!openRouterModelInfos) return undefined
  return openRouterModelInfos.get(modelId)?.contextWindow
}

export function getOpenRouterModelReasoningOptions(modelId: string): string[] | undefined {
  if (!openRouterModelInfos) return undefined
  return openRouterModelInfos.get(modelId)?.reasoningOptions
}

// Start background fetch if OpenRouter is configured
export function startOpenRouterModelsFetch(): void {
  // Non-blocking background fetch
  void fetchOpenRouterModels()
}