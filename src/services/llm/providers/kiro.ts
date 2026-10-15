import type { ProviderId, ProtocolId } from '../types.js'
import { getKiroRegion } from '../../../utils/model/providers.js'

// Kiro speaks the AWS CodeWhisperer Streaming protocol directly:
//   POST https://q.{region}.amazonaws.com/
//   X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
// Auth: Bearer access token + x-amzn-kiro-profile-arn header.
// No local proxy or 9router required.
export const kiro = {
  id: 'kiro' as ProviderId,
  defaultProtocol: 'aws-eventstream' as ProtocolId,
  get defaultEndpoint(): string {
    const base = process.env.KIRO_BASE_URL?.replace(/\/$/, '') ?? `https://q.${getKiroRegion() || 'us-east-1'}.amazonaws.com`
    return `${base}/`
  },
  get protocol(): ProtocolId { return this.defaultProtocol },
  get endpoint(): string { return this.defaultEndpoint },
  resolveModel(fallback: string): string { return fallback },
} as const