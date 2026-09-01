export type ModelMetadata = {
  id: string
  capabilities: {
    tools: boolean
    vision: boolean
    reasoning: boolean
    streaming: boolean
  }
}

const REGISTRY: Record<string, ModelMetadata> = {
  'big-pickle': { id: 'big-pickle', capabilities: { tools: true, vision: true, reasoning: true, streaming: true } },
  'default': { id: 'default', capabilities: { tools: true, vision: true, reasoning: false, streaming: true } },
}

export function getModelMetadata(id: string): ModelMetadata {
  return REGISTRY[id] ?? REGISTRY['default']!
}
