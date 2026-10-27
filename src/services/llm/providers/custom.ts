import type { ProviderId, ProtocolId } from '../types.js'
import { getCustomBaseUrl } from '../../../utils/model/providers.js'
import { resolveCustomModel } from '../models/modelResolver.js'

export const custom = {
  id: 'custom' as ProviderId,
  defaultProtocol: 'openai-compatible-chat' as ProtocolId,
  get defaultEndpoint(): string {
    const base = (getCustomBaseUrl() ?? 'http://localhost:8000/v1').replace(/\/+$/, '')
    return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string {
    return resolveCustomModel(fallback)
  },
} as const
