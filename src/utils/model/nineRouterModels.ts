import type { ModelOption } from './modelOptions.js'
import { recordProviderContextWindows } from './contextWindowStore.js'

const NINE_ROUTER_BASE_URL = () =>
  (process.env.NINE_ROUTER_BASE_URL ?? 'http://localhost:20128/v1').replace(/\/+$/, '')

let cache: ModelOption[] = []
let contextWindows: Map<string, number> = new Map()
let maxOutputs: Map<string, number> = new Map()
let fetching: Promise<ModelOption[]> | undefined

function normalizeModelId(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').toLowerCase()
}

function modelProvider(id: string, owner?: string): string {
  return id.includes('/') ? id.split('/')[0] : owner?.trim() || 'Other'
}

export function getCachedNineRouterModels(): ModelOption[] {
  return cache
}

export function getNineRouterModelContextWindow(modelId: string): number | undefined {
  const direct = contextWindows.get(normalizeModelId(modelId))
  if (direct) return direct
  // fallback to persisted store handled by caller via getStoredProviderContextWindow
  return undefined
}

export function getNineRouterModelMaxOutput(modelId: string): number | undefined {
  return maxOutputs.get(normalizeModelId(modelId))
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
        data?: Array<{
          id?: string
          owned_by?: string
          name?: string
          context_length?: number
          max_completion_tokens?: number
          capabilities?: { contextWindow?: number; maxOutput?: number }
        }>
      }
      const entries: Array<{ id: string; contextWindow: number; promptLimit?: number }> = []
      const next: ModelOption[] = []
      const nextWindows = new Map<string, number>()
      const nextMaxOutputs = new Map<string, number>()
      for (const model of payload.data ?? []) {
        if (typeof model.id !== 'string' || model.id.length === 0) continue
        const id = model.id
        const provider = modelProvider(id, model.owned_by)
        const contextWindow =
          model.capabilities?.contextWindow ?? model.context_length
        const maxOutput =
          model.capabilities?.maxOutput ?? model.max_completion_tokens
        if (typeof contextWindow === 'number' && contextWindow > 0) {
          nextWindows.set(normalizeModelId(id), Math.floor(contextWindow))
          entries.push({ id, contextWindow: Math.floor(contextWindow) })
        }
        if (typeof maxOutput === 'number' && maxOutput > 0) {
          nextMaxOutputs.set(normalizeModelId(id), Math.floor(maxOutput))
        }
        next.push({
          value: id,
          label: `${provider} / ${model.name || id.split('/').slice(1).join('/') || id}`,
          description: provider,
          descriptionForModel: `${provider} provider · ${id}`,
        })
      }
      next.sort((a, b) => a.description.localeCompare(b.description) || a.label.localeCompare(b.label))
      cache = next
      contextWindows = nextWindows
      maxOutputs = nextMaxOutputs
      try {
        recordProviderContextWindows('openai', entries)
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