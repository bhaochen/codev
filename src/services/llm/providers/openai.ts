import type { ProviderId, ProtocolId } from '../types.js'
import { getOpenAIBaseUrl } from '../../../utils/model/providers.js'
import { resolveOpenAIModel } from '@ant/model-provider'

export const openai = {
  id: 'openai' as ProviderId,
  defaultProtocol: 'openai-chat' as ProtocolId,
  get defaultEndpoint(): string { return getOpenAIBaseUrl() + '/chat/completions' },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return resolveOpenAIModel(fallback) },
} as const
