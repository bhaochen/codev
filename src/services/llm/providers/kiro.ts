import type { ProviderId, ProtocolId } from '../types.js'
import { getKiroBaseUrl, getKiroRegion } from '../../../utils/model/providers.js'

// Kiro uses AWS EventStream protocol (similar to Bedrock Converse but different format)
// For now, we'll use the anthropic-messages protocol as a placeholder
// A full implementation would require a custom 'aws-eventstream' protocol handler

export const kiro = {
  id: 'kiro' as ProviderId,
  defaultProtocol: 'anthropic-messages' as ProtocolId,
  get defaultEndpoint(): string {
    const region = getKiroRegion()
    return `https://q.${region}.amazonaws.com`
  },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return fallback },
} as const