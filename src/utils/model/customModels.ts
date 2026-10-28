import type { ModelOption } from './modelOptions.js'
import { getCustomBaseUrl } from './providers.js'
import { getCustomApiConfig } from '../auth.js'
import { recordProviderContextWindows } from './contextWindowStore.js'

let cache: ModelOption[] = []
let contextWindows: Map<string, number> = new Map()
let maxOutputs: Map<string, number> = new Map()
let fetching: Promise<ModelOption[]> | undefined

function normalizeModelId(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').toLowerCase()
}

export function getCachedCustomModels(): ModelOption[] {
  return cache
}

export function getCustomModelContextWindow(modelId: string): number | undefined {
  const direct = contextWindows.get(normalizeModelId(modelId))
  if (direct) return direct
  return undefined
}

export function getCustomModelMaxOutput(modelId: string): number | undefined {
  return maxOutputs.get(normalizeModelId(modelId))
}

export async function fetchCustomModels(): Promise<ModelOption[]> {
  if (fetching) return fetching
  fetching = (async () => {
    try {
      const baseUrl = getCustomBaseUrl()
      if (!baseUrl) return cache
      const { apiKey } = getCustomApiConfig()
      const modelsUrl = baseUrl.replace(/\/+$/, '') + '/v1/models'
      const headers: Record<string, string> = {}
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const response = await fetch(modelsUrl, {
        signal: AbortSignal.timeout(5000),
        headers,
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
      const entries: Array<{ id: string; contextWindow: number }> = []
      const next: ModelOption[] = []
      const nextWindows = new Map<string, number>()
      const nextMaxOutputs = new Map<string, number>()
      for (const model of payload.data ?? []) {
        if (typeof model.id !== 'string' || model.id.length === 0) continue
        const id = model.id
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
          label: model.name || id,
          description: 'Custom model',
          descriptionForModel: id,
        })
      }
      next.sort((a, b) => a.label.localeCompare(b.label))
      cache = next
      contextWindows = nextWindows
      maxOutputs = nextMaxOutputs
      try {
        recordProviderContextWindows('custom', entries)
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
