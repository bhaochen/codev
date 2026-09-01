import type { ProtocolId, ProviderId } from '../types.js'
import { getProviderDef } from '../providers/index.js'

export function resolveProtocol(provider: ProviderId): ProtocolId {
  const def = getProviderDef(provider) as { protocol: ProtocolId }
  return def.protocol
}
