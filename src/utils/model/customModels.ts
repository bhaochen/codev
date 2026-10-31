import type { ModelOption } from './modelOptions.js'
import { recordProviderContextWindows } from './contextWindowStore.js'
import { getActiveCustomEndpoints, getModelsUrl } from './providers.js'

export interface CustomEndpointModel {
  id: string
  baseUrl: string
  name?: string
  contextWindow?: number
  maxOutput?: number
}

let cache: CustomEndpointModel[] = []
let fetching: Promise<CustomEndpointModel[]> | undefined

export function getCachedCustomModels(): CustomEndpointModel[] {
  return cache
}

/**
 * Look up a model by its exact catalog id, fetching the /models catalog once
 * when the cache is empty (one-shot --print runs with --bare skip prefetches,
 * so the background fetch may never have happened).
 */
export async function findOrFetchCustomModel(model: string): Promise<CustomEndpointModel | undefined> {
  if (cache.length === 0) {
    await fetchCustomModels().catch(() => undefined)
  }
  return cache.find(m => m.id === model)
}

/** Reset the module-level cache for test isolation. */
export function resetCustomModelsForTests(): void {
  cache = []
  fetching = undefined
}

export async function fetchCustomModels(
  endpoints: Array<{ id: string; baseUrl: string; apiKey?: string }> = getActiveCustomEndpoints(),
): Promise<CustomEndpointModel[]> {
  if (fetching) return fetching
  fetching = (async () => {
    try {
      const results: CustomEndpointModel[] = []
      const fetches = endpoints.map(async ep => {
        try {
          const modelsUrl = getModelsUrl(ep.baseUrl)
          const headers: Record<string, string> = {}
          if (ep.apiKey) headers['Authorization'] = `Bearer ${ep.apiKey}`
          const response = await fetch(modelsUrl, {
            signal: AbortSignal.timeout(5000),
            headers,
          })
          if (!response.ok) return
          const payload = await response.json() as {
            data?: Array<{
              id?: string
              name?: string
              context_length?: number
              max_completion_tokens?: number
              output_modalities?: string[]
              capabilities?: { contextWindow?: number; maxOutput?: number }
              meta?: { n_ctx?: number }
            }>
          }
          for (const model of payload.data ?? []) {
            if (typeof model.id !== 'string' || model.id.length === 0) continue
            // Skip non-text models (audio transcription, speech synthesis,
            // guard classifiers, …) — they can't serve chat completions.
            if (
              model.output_modalities !== undefined &&
              !model.output_modalities.includes('text')
            ) {
              continue
            }
            const contextWindow =
              model.capabilities?.contextWindow
              ?? model.context_length
              ?? model.meta?.n_ctx
            const maxOutput =
              model.capabilities?.maxOutput
              ?? model.max_completion_tokens
            // Keep models even when the server omits context metadata — the
            // picker only needs id/name, and hiding them makes valid models
            // disappear from /model.
            const hasContextWindow =
              typeof contextWindow === 'number' && contextWindow > 0
            results.push({
              id: model.id,
              baseUrl: ep.baseUrl,
              name: model.name,
              contextWindow: hasContextWindow ? Math.floor(contextWindow) : undefined,
              maxOutput: typeof maxOutput === 'number' ? Math.floor(maxOutput) : undefined,
            })
          }
        } catch {
          // Ignore per-endpoint fetch errors
        }
      })
      await Promise.all(fetches)
      results.sort((a, b) => a.baseUrl.localeCompare(b.baseUrl) || a.id.localeCompare(b.id))
      cache = results
      try {
        recordProviderContextWindows(
          'custom',
          results.flatMap(r =>
            r.contextWindow !== undefined
              ? [{ id: r.id, contextWindow: r.contextWindow }]
              : [],
          ),
        )
      } catch {
        // ignore
      }
      return cache
    } catch {
      return cache
    } finally {
      fetching = undefined
    }
  })()
  return fetching
}
