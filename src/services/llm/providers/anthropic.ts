import type { ProviderId, ProtocolId } from '../types.js'

export const anthropic = {
  id: 'firstParty' as ProviderId,
  defaultProtocol: 'anthropic-messages' as ProtocolId,
  get defaultEndpoint(): string | undefined { return undefined },
  // compatibility alias — provider no longer exclusively owns protocol
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string | undefined { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return fallback },
} as const
