import type { ProviderId, ProtocolId } from '../types.js'
import { getChatCompletionsUrl, getCustomBaseUrl } from '../../../utils/model/providers.js'
import { resolveCustomModel } from '../models/modelResolver.js'

export const custom = {
  id: 'custom' as ProviderId,
  defaultProtocol: 'openai-compatible-chat' as ProtocolId,
  get defaultEndpoint(): string {
    return getChatCompletionsUrl(getCustomBaseUrl() ?? 'http://localhost:8000/v1')
  },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string {
    return resolveCustomModel(fallback)
  },
} as const
