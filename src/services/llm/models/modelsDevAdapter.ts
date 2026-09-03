/**
 * models.dev → ModelDefinition Adapter — Phase 12B
 * Pure function, no fetch/cache/registry/provider coupling.
 * Keeps canonical provider/model id (e.g. "openai/gpt-5").
 */

import type { ModelDefinition } from './registry.js'

/** Minimal projection of models.dev model — only fields used for mapping. */
export type ModelsDevModel = {
  id: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export function fromModelsDev(raw: unknown): ModelDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid models.dev model: expected object')
  }
  const r = raw as Record<string, unknown>

  const id = r.id
  if (!isNonEmptyString(id)) {
    throw new Error('Invalid models.dev model: missing id')
  }

  const reasoning = r.reasoning === true
  const toolCall = (r as { tool_call?: unknown }).tool_call === true
  const attachment = (r as { attachment?: unknown }).attachment === true

  const modalities = r.modalities as { input?: unknown; output?: unknown } | undefined
  const inputMods: string[] = Array.isArray(modalities?.input)
    ? (modalities.input.filter((x): x is string => typeof x === 'string') as string[])
    : []

  const hasImageOrPdf = inputMods.includes('image') || inputMods.includes('pdf')
  const vision = attachment === true && hasImageOrPdf

  return {
    id: id.trim(),
    capabilities: {
      tools: toolCall,
      vision,
      reasoning,
      streaming: true,
    },
  }
}

/** Batch helper — maps array, skips invalid entries via throw (caller decides). */
export function fromModelsDevBatch(rawList: unknown[]): ModelDefinition[] {
  return rawList.map(fromModelsDev)
}
