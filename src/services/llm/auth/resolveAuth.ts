import type { ProviderId } from '../types.js'
import { getOpenCodeApiKey } from '../../../utils/auth.js'
import { getOpenAIApiKey } from '../../../utils/auth.js'
import { getNvidiaApiKey } from '../../../utils/auth.js'

export type Credential = { type: 'bearer'; token: string } | { type: 'none' }

export function resolveAuth(provider: ProviderId): Credential {
  switch (provider) {
    case 'opencode': {
      const k = getOpenCodeApiKey()
      return k ? { type: 'bearer', token: k } : { type: 'bearer', token: 'public' }
    }
    case 'openai': {
      const k = getOpenAIApiKey()
      return k ? { type: 'bearer', token: k } : { type: 'none' }
    }
    case 'nvidia': {
      try {
        const k = getNvidiaApiKey()
        return k ? { type: 'bearer', token: k } : { type: 'none' }
      } catch { return { type: 'none' } }
    }
    default:
      return { type: 'none' }
  }
}
