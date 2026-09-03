import type { ProviderId, ProtocolId } from '../types.js'
import { getNvidiaBaseUrl } from '../../../utils/model/providers.js'

// 对齐 opencode/packages/opencode/src/provider/provider.ts:484 nvidia 非 fetch-override，直连 openai-chat
export const nvidia = {
  id: 'nvidia' as ProviderId,
  defaultProtocol: 'openai-chat' as ProtocolId,
  get defaultEndpoint(): string { return getNvidiaBaseUrl() + '/chat/completions' },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return fallback },
} as const
