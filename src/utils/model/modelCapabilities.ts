/** Model limits come from Codev's local catalogs; no Anthropic /v1/models fetch. */
export type ModelCapability = {
  id: string
  max_input_tokens?: number
  max_tokens?: number
}

export function getModelCapability(_model: string): ModelCapability | undefined {
  return undefined
}

export async function refreshModelCapabilities(): Promise<void> {}
