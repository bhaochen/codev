/**
 * Model Registry — Phase 12C: merged local + models.dev with local precedence.
 * Does NOT own Provider, Protocol, Auth, Transport, or network.
 * Unknown models passthrough via resolver; Registry only enriches known ones.
 */
import { fromModelsDev } from './modelsDevAdapter.js'

export type ModelId = string

export type ModelDefinition = {
  id: ModelId
  capabilities: {
    tools: boolean
    vision: boolean
    reasoning: boolean
    streaming: boolean
  }
}

/** Compatibility alias — existing code imports ModelMetadata */
export type ModelMetadata = ModelDefinition

const LOCAL_REGISTRY: Record<string, ModelDefinition> = {
  'big-pickle': { id: 'big-pickle', capabilities: { tools: true, vision: true, reasoning: true, streaming: true } },
  default: { id: 'default', capabilities: { tools: true, vision: true, reasoning: false, streaming: true } },
}

const MODELS_DEV_REGISTRY: Record<string, ModelDefinition> = {}

/** Local > models.dev precedence — local always wins */
function mergedGet(id: ModelId): ModelDefinition | undefined {
  return LOCAL_REGISTRY[id] ?? MODELS_DEV_REGISTRY[id]
}

export function hasModel(id: ModelId): boolean {
  return Object.prototype.hasOwnProperty.call(LOCAL_REGISTRY, id) || Object.prototype.hasOwnProperty.call(MODELS_DEV_REGISTRY, id)
}

export function getModel(id: ModelId): ModelDefinition | undefined {
  return mergedGet(id)
}

/** Existing API — returns default for unknown to preserve passthrough behavior. */
export function getModelMetadata(id: string): ModelDefinition {
  return mergedGet(id) ?? LOCAL_REGISTRY.default!
}

/** Register models.dev raw models via adapter — local wins, duplicates ignored. */
export function registerModelsDev(rawList: unknown[]): { added: number; skipped: number } {
  let added = 0
  let skipped = 0
  for (const raw of rawList) {
    try {
      const def = fromModelsDev(raw)
      const id = def.id
      if (Object.prototype.hasOwnProperty.call(LOCAL_REGISTRY, id) || Object.prototype.hasOwnProperty.call(MODELS_DEV_REGISTRY, id)) {
        skipped++
        continue
      }
      MODELS_DEV_REGISTRY[id] = def
      added++
    } catch {
      skipped++
    }
  }
  return { added, skipped }
}

/** Clear models.dev layer — for tests / reset */
export function clearModelsDev(): void {
  for (const k of Object.keys(MODELS_DEV_REGISTRY)) delete MODELS_DEV_REGISTRY[k]
}

/** Optional registry view for future extensibility */
export const ModelRegistry = {
  has: hasModel,
  get: getModel,
  getOrDefault: getModelMetadata,
  list: (): ModelDefinition[] => {
    const seen = new Set<string>()
    const out: ModelDefinition[] = []
    for (const m of Object.values(LOCAL_REGISTRY)) {
      seen.add(m.id)
      out.push(m)
    }
    for (const m of Object.values(MODELS_DEV_REGISTRY)) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        out.push(m)
      }
    }
    return out
  },
  registerModelsDev,
  clearModelsDev,
} as const
