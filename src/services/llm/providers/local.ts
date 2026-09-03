import type { ProviderId, ProtocolId } from '../types.js'

export const local = {
  id: 'local' as ProviderId,
  defaultProtocol: 'anthropic-messages' as ProtocolId,
  get defaultEndpoint(): string | undefined { return undefined },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string | undefined { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return fallback },
} as const
