import type { ProviderId, ProtocolId } from '../types.js'
import { getNvidiaBaseUrl } from '../../../utils/model/providers.js'

// 对齐 opencode/packages/opencode/src/provider/provider.ts:484 nvidia 非 fetch-override，直连 openai-chat
export const nvidia = {
  id: 'nvidia' as ProviderId,
  protocol: 'openai-chat' as ProtocolId,
  get endpoint(): string { return getNvidiaBaseUrl() + '/chat/completions' },
  resolveModel(fallback: string): string { return fallback },
} as const
