import type { ProviderId, ProtocolId } from '../types.js'
import { getOpenCodeApiKey, getOpenCodeModelName } from '../../../utils/auth.js'
import { getOpencodeBaseUrl } from '../../../utils/model/providers.js'

function isFreeModel(modelId: string): boolean {
  try {
    const { getCachedOpencodeModels } = require('../../api/opencodeClient.js') as typeof import('../../api/opencodeClient.js')
    const list = getCachedOpencodeModels()
    const hit = list.find(m => m.id === modelId || modelId.includes(m.id) || m.id.includes(modelId))
    return hit?.isFree ?? false
  } catch { return false }
}

export const opencode = {
  id: 'opencode' as ProviderId,
  defaultProtocol: 'openai-chat' as ProtocolId,
  get defaultEndpoint(): string { return getOpencodeBaseUrl() + '/chat/completions' },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string {
    try { return getOpenCodeModelName() || fallback || 'big-pickle' } catch { return fallback || 'big-pickle' }
  },
  isFreeModel,
  getAuthHeader(): string {
    try {
      const k = getOpenCodeApiKey()
      if (k && k !== 'public') return `Bearer ${k}`
      // 无有效 key 时按 opencode custom 逻辑仅放行 free 模型，强制 public
      return 'Bearer public'
    } catch { return 'Bearer public' }
  },
} as const
