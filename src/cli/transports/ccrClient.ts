/**
 * CCR Client - stub
 * Not implemented; preserves the type surface used by v2 replBridge.
 */

import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import type { SessionState } from '../../utils/sessionState.js'
import type { SSETransport } from './SSETransport.js'

export class CCRClient {
  constructor(
    sse: SSETransport,
    url: URL,
    opts?: {
      getAuthHeaders?: () => Record<string, string>
      heartbeatIntervalMs?: number
      heartbeatJitterFraction?: number
      onEpochMismatch?: () => never
    },
  ) {
    console.error('CCRClient not implemented');
  }

  async connect(): Promise<void> {
    console.error('CCRClient.connect not implemented');
  }

  async disconnect(): Promise<void> {
    console.error('CCRClient.disconnect not implemented');
  }

  async send(data: any): Promise<void> {
    console.error('CCRClient.send not implemented');
  }

  async receive(): Promise<any> {
    console.error('CCRClient.receive not implemented');
    return null;
  }

  async initialize(epoch?: number): Promise<void> {
    console.error('CCRClient.initialize not implemented');
  }

  async writeEvent(message: StdoutMessage): Promise<void> {
    console.error('CCRClient.writeEvent not implemented');
  }

  close(): void {
    console.error('CCRClient.close not implemented');
  }

  reportState(state: SessionState): void {
    console.error('CCRClient.reportState not implemented');
  }

  reportMetadata(metadata: Record<string, unknown>): void {
    console.error('CCRClient.reportMetadata not implemented');
  }

  reportDelivery(
    eventId: string,
    status: 'received' | 'processing' | 'processed',
  ): void {
    console.error('CCRClient.reportDelivery not implemented');
  }

  async flush(): Promise<void> {
    console.error('CCRClient.flush not implemented');
  }
}