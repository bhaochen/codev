import type { ModelOption } from './modelOptions.js'

const NINE_ROUTER_BASE_URL = () =>
  (process.env.NINE_ROUTER_BASE_URL ?? 'http://localhost:20128/v1').replace(/\/+$/, '')

let cache: ModelOption[] = []
let fetching: Promise<ModelOption[]> | undefined

function modelProvider(id: string, owner?: string): string {
  return id.includes('/') ? id.split('/')[0] : owner?.trim() || 'Other'
}

export function getCachedNineRouterModels(): ModelOption[] {
  return cache
}

export async function fetchNineRouterModels(): Promise<ModelOption[]> {
  if (fetching) return fetching
  fetching = (async () => {
    try {
      const response = await fetch(`${NINE_ROUTER_BASE_URL()}/models`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return cache
      const payload = await response.json() as {
        data?: Array<{ id?: string; owned_by?: string; name?: string }>
      }
      cache = (payload.data ?? [])
        .filter(model => typeof model.id === 'string' && model.id.length > 0)
        .map(model => {
          const id = model.id!
          const provider = modelProvider(id, model.owned_by)
          return {
            value: id,
            label: `${provider} / ${model.name || id.split('/').slice(1).join('/') || id}`,
            description: provider,
            descriptionForModel: `${provider} provider · ${id}`,
          }
        })
        .sort((a, b) => a.description.localeCompare(b.description) || a.label.localeCompare(b.label))
      return cache
    } catch {
      return cache
    } finally {
      fetching = undefined
    }
  })()
  return fetching
}
