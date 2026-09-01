import type { ProviderId, ProtocolId } from '../types.js'

export const anthropic = {
  id: 'anthropic' as ProviderId,
  protocol: 'anthropic-messages' as ProtocolId,
  endpoint: undefined as string | undefined,
  resolveModel(fallback: string): string { return fallback },
} as const
