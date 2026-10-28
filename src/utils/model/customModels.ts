import type { ModelOption } from './modelOptions.js'
import { recordProviderContextWindows } from './contextWindowStore.js'
import { getCustomEndpoints } from './providers.js'

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

export async function fetchCustomModels(
  endpoints: Array<{ id: string; baseUrl: string; apiKey?: string }> = getCustomEndpoints(),
): Promise<CustomEndpointModel[]> {
  if (fetching) return fetching
  fetching = (async () => {
    try {
      const results: CustomEndpointModel[] = []
      const fetches = endpoints.map(async ep => {
        try {
          const modelsUrl = ep.baseUrl.replace(/\/+$/, '') + '/v1/models'
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
              capabilities?: { contextWindow?: number; maxOutput?: number }
              meta?: { n_ctx?: number }
            }>
          }
          for (const model of payload.data ?? []) {
            if (typeof model.id !== 'string' || model.id.length === 0) continue
            const contextWindow =
              model.capabilities?.contextWindow
              ?? model.context_length
              ?? model.meta?.n_ctx
            const maxOutput =
              model.capabilities?.maxOutput
              ?? model.max_completion_tokens
            if (typeof contextWindow !== 'number' || contextWindow <= 0) continue
            results.push({
              id: model.id,
              baseUrl: ep.baseUrl,
              name: model.name,
              contextWindow: Math.floor(contextWindow),
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
        recordProviderContextWindows('custom', results.map(r => ({ id: r.id, contextWindow: r.contextWindow! })))
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
