/**
 * Model Registry — Phase 11: local lookup for known Model metadata.
 * Does NOT own Provider, Protocol, Auth, Transport, or network.
 * Unknown models passthrough via resolver; Registry only enriches known ones.
 */
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

const REGISTRY: Record<string, ModelDefinition> = {
  'big-pickle': { id: 'big-pickle', capabilities: { tools: true, vision: true, reasoning: true, streaming: true } },
  default: { id: 'default', capabilities: { tools: true, vision: true, reasoning: false, streaming: true } },
}

export function hasModel(id: ModelId): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id)
}

export function getModel(id: ModelId): ModelDefinition | undefined {
  return REGISTRY[id]
}

/** Existing API — returns default for unknown to preserve passthrough behavior. */
export function getModelMetadata(id: string): ModelDefinition {
  return REGISTRY[id] ?? REGISTRY.default!
}

/** Optional registry view for future extensibility */
export const ModelRegistry = {
  has: hasModel,
  get: getModel,
  getOrDefault: getModelMetadata,
  list: (): ModelDefinition[] => Object.values(REGISTRY),
} as const
