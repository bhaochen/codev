import type { ModelOption } from './modelOptions.js'

const MODELS_META_URL = 'https://models.dev/api.json'

let openAIModelsCache: ModelOption[] | null = null
let cacheTimestamp = 0
let isFetching = false
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

// Models.dev lists the full OpenAI catalog (images, embeddings, realtime, GPT-4,
// o-series…). The codex CLI only surfaces GPT-5.x chat models, so keep those.
const NON_CHAT_PATTERNS =
  /text-embedding|gpt-image|chatgpt-image|realtime|audio|tts|whisper|moderation/

function toModelOption(
  modelId: string,
  config: {
    name?: string
    status?: string
    limit?: { context?: number; output?: number }
  },
): ModelOption | null {
  if (config.status === 'deprecated') return null
  if (!modelId.startsWith('gpt-5')) return null
  if (NON_CHAT_PATTERNS.test(modelId)) return null

  const label = config.name || modelId
  const context = config.limit?.context
  const contextSuffix = context ? ` · ${context.toLocaleString()} context` : ''
  return {
    value: modelId,
    label,
    description: `${label}${contextSuffix}`,
    descriptionForModel: `OpenAI model (${modelId})${contextSuffix}`,
  }
}

export async function fetchOpenAIModels(): Promise<ModelOption[]> {
  // Check cache
  if (
    openAIModelsCache !== null &&
    Date.now() - cacheTimestamp < CACHE_DURATION
  ) {
    return openAIModelsCache
  }

  // Prevent concurrent fetches
  if (isFetching) {
    return openAIModelsCache || []
  }

  isFetching = true

  try {
    const res = await fetch(MODELS_META_URL, {
      headers: {
        'User-Agent':
          'opencode/1.15.6 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return []
    }

    const data = (await res.json()) as {
      openai?: {
        models?: Record<string, {
          name?: string
          status?: string
          limit?: { context?: number; output?: number }
        }>
      }
    }
    const openaiModels = data?.openai?.models || {}
    const options = Object.entries(openaiModels)
      .map(([modelId, config]) => toModelOption(modelId, config))
      .filter((opt): opt is ModelOption => opt !== null)

    if (options.length > 0) {
      openAIModelsCache = options
      cacheTimestamp = Date.now()
      return options
    }
    return []
  } catch {
    return []
  } finally {
    isFetching = false
  }
}

export function getCachedOpenAIModels(): ModelOption[] {
  return openAIModelsCache || []
}

export function hasOpenAIModelsCache(): boolean {
  return openAIModelsCache !== null
}

export function clearOpenAIModelsCache(): void {
  openAIModelsCache = null
  cacheTimestamp = 0
}

// Start background fetch if OpenAI is configured
export function startOpenAIModelsFetch(): void {
  void fetchOpenAIModels()
}
