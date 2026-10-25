import type { ModelOption } from './modelOptions.js'
import { getOpenAIApiKey, getOpenAIAuthTokens } from '../auth.js'
import { getOpenAIBaseUrl } from './providers.js'
import { isChatGPTAuthEnabled } from '../../services/api/openai/chatgptAuth.js'
import { getOpenAIContextWindowForModel } from '../../services/openaiAuth/models.js'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const CODEX_MODELS_PATH = '/codex/models'
const CODEX_CLIENT_VERSION = '0.144.1'
const DEFAULT_CONTEXT_WINDOW = 272_000

let openAIModelsCache: ModelOption[] | null = null
let cacheTimestamp = 0
let isFetching = false
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

// Keep only GPT-5.x chat models — the codex CLI / ChatGPT surface does not show
// embeddings, image, realtime or audio models.
const NON_CHAT_PATTERNS =
  /text-embedding|gpt-image|chatgpt-image|realtime|audio|tts|whisper|moderation/

function isGpt5ChatModel(modelId: string): boolean {
  if (!modelId.startsWith('gpt-5')) return false
  if (NON_CHAT_PATTERNS.test(modelId)) return false
  return true
}

function toModelOption(
  modelId: string,
  label: string,
  contextWindow?: number,
): ModelOption | null {
  if (!isGpt5ChatModel(modelId)) return null

  const context =
    contextWindow ?? getOpenAIContextWindowForModel(modelId) ?? undefined
  const contextSuffix = context ? ` · ${context.toLocaleString()} context` : ''
  return {
    value: modelId,
    label,
    description: `${label}${contextSuffix}`,
    descriptionForModel: `OpenAI model (${modelId})${contextSuffix}`,
  }
}

type CodexModelEntry = {
  slug?: string
  id?: string
  display_name?: string
  context_window?: number
  visibility?: string
  priority?: number
}

/**
 * Fetch the account's Codex model catalog from the ChatGPT backend
 * (mirrors the codex CLI / omp `fetchCodexModels`). The subscription account's
 * usable models are not a subset of the public catalog — the backend returns
 * the exact slugs + context windows the account can actually run.
 */
async function fetchCodexModels(): Promise<ModelOption[]> {
  // Import lazily: chatgptAuth pulls the refresh-token machinery that is only
  // relevant when a ChatGPT OAuth session exists.
  const { getValidChatGPTAuth } = await import(
    '../../services/api/openai/chatgptAuth.js'
  )

  let accessToken: string
  let accountId: string | undefined
  try {
    const auth = await getValidChatGPTAuth()
    accessToken = auth.accessToken
    accountId = auth.accountId
  } catch {
    // No config-managed OAuth session; allow env-provided tokens to still hit
    // the codex backend (CODEX_ACCESS_TOKEN / OPENAI_ACCESS_TOKEN).
    const envToken =
      process.env.CODEX_ACCESS_TOKEN ?? process.env.OPENAI_ACCESS_TOKEN
    if (!envToken) return []
    accessToken = envToken
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'OpenAI-Beta': 'responses=experimental',
    originator: 'claude-code-best',
    version: CODEX_CLIENT_VERSION,
  }
  if (accountId) {
    headers['chatgpt-account-id'] = accountId
  }

  const url = `${CODEX_BASE_URL}${CODEX_MODELS_PATH}?client_version=${CODEX_CLIENT_VERSION}`
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return []

  const payload = (await res.json()) as {
    models?: CodexModelEntry[]
    data?: CodexModelEntry[]
  }
  const entries = payload.models ?? payload.data ?? []

  const normalized: { priority: number; option: ModelOption }[] = []
  for (const entry of entries) {
    const slug = entry.slug?.trim() || entry.id?.trim()
    if (!slug) continue
    const visibility = entry.visibility?.toLowerCase()
    if (visibility === 'hide' || visibility === 'hidden') continue

    const option = toModelOption(
      slug,
      entry.display_name?.trim() || slug,
      entry.context_window ?? DEFAULT_CONTEXT_WINDOW,
    )
    if (option) {
      normalized.push({
        priority: typeof entry.priority === 'number' ? entry.priority : Number.MAX_SAFE_INTEGER,
        option,
      })
    }
  }

  normalized.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.option.value.localeCompare(b.option.value)
  })
  return normalized.map(item => item.option)
}

/**
 * Fetch the OpenAI-compatible `/models` catalog (API-key / self-hosted
 * endpoints). The standard `{ data: [{ id, ... }] }` envelope is expected.
 * Falls back to env var ANTHROPIC_CUSTOM_MODEL_OPTION if /models fails.
 */
async function fetchOpenAICompatibleModels(): Promise<ModelOption[]> {
  const apiKey = getOpenAIApiKey()
  if (!apiKey) return []

  const baseUrl = getOpenAIBaseUrl().replace(/\/+$/, '')
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const payload = (await res.json()) as {
        data?: { id?: string }[]
      }
      const entries = payload.data ?? []

      const options: ModelOption[] = []
      for (const entry of entries) {
        const modelId = entry.id?.trim()
        if (!modelId) continue
        // For custom endpoints, don't filter by gpt-5 prefix - allow any model
        const context = getOpenAIContextWindowForModel(modelId) ?? undefined
        const contextSuffix = context ? ` · ${context.toLocaleString()} context` : ''
        options.push({
          value: modelId,
          label: modelId,
          description: `${modelId}${contextSuffix}`,
          descriptionForModel: `OpenAI-compatible model (${modelId})${contextSuffix}`,
        })
      }
      if (options.length > 0) return options.sort((a, b) => a.value.localeCompare(b.value))
    }
  } catch {
    // Ignore fetch errors, fall through to env var fallback
  }

  // Fallback: use ANTHROPIC_CUSTOM_MODEL_OPTION if set (for non-OpenAI models via proxy)
  const customModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (customModel) {
    return [{
      value: customModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? customModel,
      description: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ?? `Custom model (${customModel})`,
      descriptionForModel: `Custom model (${customModel})`,
    }]
  }

  return []
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
    // Codex subscription (ChatGPT OAuth session present, or explicitly opted in
    // via OPENAI_AUTH_MODE=chatgpt) → ChatGPT backend catalog. Otherwise the
    // API-key / OpenAI-compatible `/models` endpoint. Env-provided codex-style
    // access tokens (CODEX_ACCESS_TOKEN / OPENAI_ACCESS_TOKEN) route to the
    // codex backend too — they are ChatGPT-session tokens, not platform keys.
    const useCodex =
      isChatGPTAuthEnabled() ||
      getOpenAIAuthTokens() !== null ||
      Boolean(process.env.CODEX_ACCESS_TOKEN) ||
      Boolean(process.env.OPENAI_ACCESS_TOKEN)
    const options = useCodex ? await fetchCodexModels() : await fetchOpenAICompatibleModels()

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
