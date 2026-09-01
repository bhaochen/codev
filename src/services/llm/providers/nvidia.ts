import type { ProviderId, ProtocolId } from '../types.js'
import { getNvidiaBaseUrl } from '../../../utils/model/providers.js'

// 当前 fetch-override 兼容，终态 native HTTP 仍 anthropic-messages
export const nvidia = {
  id: 'nvidia' as ProviderId,
  protocol: 'anthropic-messages' as ProtocolId,
  get endpoint(): string { return getNvidiaBaseUrl() + '/chat/completions' },
  resolveModel(fallback: string): string { return fallback },
  transport: 'fetch-override' as const, // legacy, 计划迁 native-http
} as const
