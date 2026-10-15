import type { ProviderId, ProtocolId } from '../types.js'
import { getKiroRegion } from '../../../utils/model/providers.js'

// Kiro uses 9router as inference backend (same as 9router's MITM handler)
// The MITM handler forwards to 9router's /v1/chat/completions
// Default to local 9router instance; can be overridden via KIRO_BASE_URL env
function getKiroInferenceBaseUrl(): string {
  return process.env.KIRO_BASE_URL ?? 'http://localhost:8080'
}

export const kiro = {
  id: 'kiro' as ProviderId,
  defaultProtocol: 'openai-compatible-chat' as ProtocolId,
  get defaultEndpoint(): string {
    return `${getKiroInferenceBaseUrl()}/v1/chat/completions`
  },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return fallback },
} as const