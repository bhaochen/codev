import type { ModelOption } from './modelOptions.js'

let openRouterModelsCache: ModelOption[] | null = null
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

    // Convert to ModelOption format
    const options: ModelOption[] = models.map(model => {
      const promptPrice = formatPrice(model.pricing.prompt)
      const completionPrice = formatPrice(model.pricing.completion)
      const pricingText = `${promptPrice}/${completionPrice}`

      // Truncate description if too long
      let description = model.description || model.id
      if (description.length > 100) {
        description = description.substring(0, 97) + '...'
      }

      return {
        value: model.id,
        label: model.name,
        description: `${description} · ${pricingText}`,
      }
    })

    // Update cache
    openRouterModelsCache = options
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

export function clearOpenRouterModelsCache(): void {
  openRouterModelsCache = null
  cacheTimestamp = 0
}

// Start background fetch if OpenRouter is configured
export function startOpenRouterModelsFetch(): void {
  // Non-blocking background fetch
  void fetchOpenRouterModels()
}