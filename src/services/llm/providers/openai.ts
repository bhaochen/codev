import type { ProviderId, ProtocolId } from '../types.js'
import { getOpenAIBaseUrl } from '../../../utils/model/providers.js'
import { resolveOpenAIModel } from '@ant/model-provider'

export const openai = {
  id: 'openai' as ProviderId,
  protocol: 'openai-chat' as ProtocolId,
  get endpoint(): string { return getOpenAIBaseUrl() + '/chat/completions' },
  resolveModel(fallback: string): string { return resolveOpenAIModel(fallback) },
} as const
