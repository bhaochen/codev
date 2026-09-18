import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { z } from 'zod/v4'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { isClaudeAISubscriber } from '../auth.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { jsonStringify } from '../slowOperations.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'
import { getAnthropicApiKey } from '../auth.js'
import { getClaudeAIOAuthTokens } from '../auth.js'

// .strip() — don't persist internal-only fields (mycro_deployments etc.) to disk
const ModelCapabilitySchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      max_input_tokens: z.number().optional(),
      max_tokens: z.number().optional(),
    })
    .strip(),
)

const CacheFileSchema = lazySchema(() =>
  z.object({
    models: z.array(ModelCapabilitySchema()),
    timestamp: z.number(),
  }),
)

export type ModelCapability = z.infer<ReturnType<typeof ModelCapabilitySchema>>

function getCacheDir(): string {
  return join(getClaudeConfigHomeDir(), 'cache')
}

function getCachePath(): string {
  return join(getCacheDir(), 'model-capabilities.json')
}

function isModelCapabilitiesEligible(): boolean {
  const provider = getAPIProvider()
  if (provider !== 'firstParty' && provider !== null) return false
  if (!isFirstPartyAnthropicBaseUrl()) return false
  return true
}

// Longest-id-first so substring match prefers most specific; secondary key for stable isEqual
function sortForMatching(models: ModelCapability[]): ModelCapability[] {
  return [...models].sort(
    (a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id),
  )
}

// Keyed on cache path so tests that set CLAUDE_CONFIG_DIR get a fresh read
const loadCache = memoize(
  (path: string): ModelCapability[] | null => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- memoized; called from sync getContextWindowForModel
      const raw = readFileSync(path, 'utf-8')
      const parsed = CacheFileSchema().safeParse(safeParseJSON(raw, false))
      return parsed.success ? parsed.data.models : null
    } catch {
      return null
    }
  },
  path => path,
)

let _refreshing = false

export function getModelCapability(model: string): ModelCapability | undefined {
  if (!isModelCapabilitiesEligible()) return undefined
  const cached = loadCache(getCachePath())
  if (!cached || cached.length === 0) {
    if (!_refreshing) {
      _refreshing = true
      void refreshModelCapabilities().finally(() => { _refreshing = false })
    }
    return undefined
  }
  const m = model.toLowerCase()
  const exact = cached.find(c => c.id.toLowerCase() === m)
  if (exact) return exact
  return cached.find(c => m.includes(c.id.toLowerCase()))
}

/**
 * Fetch model capabilities directly from Anthropic's /v1/models endpoint.
 * Replaces the legacy Anthropic SDK client call.
 */
async function fetchModelCapabilities(): Promise<ModelCapability[]> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`

  // Get auth: try OAuth first (for Claude.ai subscribers), then API key
  let authHeader: string
  const oauthTokens = getClaudeAIOAuthTokens()
  if (oauthTokens?.accessToken) {
    authHeader = `Bearer ${oauthTokens.accessToken}`
  } else {
    const apiKey = getAnthropicApiKey()
    if (!apiKey) {
      throw new Error('No Anthropic API key or OAuth token available')
    }
    authHeader = `Bearer ${apiKey}`
  }

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    Authorization: authHeader,
  }

  if (isClaudeAISubscriber()) {
    headers['anthropic-beta'] = OAUTH_BETA_HEADER
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic /v1/models failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }

  const data = (await res.json()) as {
    data?: Array<{ id: string; max_input_tokens?: number; max_tokens?: number }>
  }

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Unexpected response format from /v1/models')
  }

  const parsed: ModelCapability[] = []
  for (const entry of data.data) {
    const result = ModelCapabilitySchema().safeParse(entry)
    if (result.success) parsed.push(result.data)
  }

  return parsed
}

export async function refreshModelCapabilities(): Promise<void> {
  if (!isModelCapabilitiesEligible()) return
  if (isEssentialTrafficOnly()) return

  try {
    const parsed = await fetchModelCapabilities()
    if (parsed.length === 0) return

    const path = getCachePath()
    const models = sortForMatching(parsed)
    if (isEqual(loadCache(path), models)) {
      logForDebugging('[modelCapabilities] cache unchanged, skipping write')
      return
    }

    await mkdir(getCacheDir(), { recursive: true })
    await writeFile(path, jsonStringify({ models, timestamp: Date.now() }), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    loadCache.cache.delete(path)
    logForDebugging(`[modelCapabilities] cached ${models.length} models`)
  } catch (error) {
    logForDebugging(
      `[modelCapabilities] fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}