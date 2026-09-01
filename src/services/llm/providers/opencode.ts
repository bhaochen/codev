import type { ProviderId, ProtocolId } from '../types.js'
import { getOpenCodeModelName } from '../../../utils/auth.js'
import { getOpencodeBaseUrl } from '../../../utils/model/providers.js'

export const opencode = {
  id: 'opencode' as ProviderId,
  protocol: 'openai-chat' as ProtocolId,
  get endpoint(): string { return getOpencodeBaseUrl() + '/chat/completions' },
  resolveModel(fallback: string): string {
    try { return getOpenCodeModelName() || fallback || 'big-pickle' } catch { return fallback || 'big-pickle' }
  },
} as const
