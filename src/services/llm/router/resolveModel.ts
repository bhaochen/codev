import { getProviderDef } from '../providers/index.js'
import type { ProviderId } from '../types.js'

export function resolveModel(provider: ProviderId, fallback: string): string {
  const def = getProviderDef(provider) as { resolveModel?: (m: string) => string }
  if (def?.resolveModel) return def.resolveModel(fallback)
  return fallback
}
