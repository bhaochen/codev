import type { ProviderId, ProtocolId } from '../types.js'
import { getKiroBaseUrl, getKiroRegion } from '../../../utils/model/providers.js'

// Kiro uses AWS EventStream protocol for Amazon Q / CodeWhisperer inference
export const kiro = {
  id: 'kiro' as ProviderId,
  defaultProtocol: 'aws-eventstream' as ProtocolId,
  get defaultEndpoint(): string {
    const region = getKiroRegion()
    return `https://q.${region}.amazonaws.com`
  },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return fallback },
} as const