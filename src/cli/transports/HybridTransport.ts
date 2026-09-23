/**
 * Hybrid Transport - stub
 * Not implemented; preserves the type surface used by v1 replBridge.
 */

import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'

export class HybridTransport {
  constructor(
    url: URL,
    headers?: Record<string, string>,
    sessionId?: string,
    getAuthHeaders?: () => Record<string, string>,
    opts?: {
      maxConsecutiveFailures?: number
      isBridge?: boolean
      onBatchDropped?: () => void
    },
  ) {
    console.error('HybridTransport not implemented');
  }

  async connect(): Promise<void> {
    console.error('HybridTransport.connect not implemented');
  }

  async disconnect(): Promise<void> {
    console.error('HybridTransport.disconnect not implemented');
  }

  async send(data: any): Promise<void> {
    console.error('HybridTransport.send not implemented');
  }

  async receive(): Promise<any> {
    console.error('HybridTransport.receive not implemented');
    return null;
  }

  async write(message: StdoutMessage): Promise<void> {
    console.error('HybridTransport.write not implemented');
  }

  async writeBatch(messages: StdoutMessage[]): Promise<void> {
    console.error('HybridTransport.writeBatch not implemented');
  }

  close(): void {
    console.error('HybridTransport.close not implemented');
  }

  isConnectedStatus(): boolean {
    return false
  }

  getStateLabel(): string {
    return 'unimplemented'
  }

  setOnData(callback: (data: string) => void): void {
    console.error('HybridTransport.setOnData not implemented');
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    console.error('HybridTransport.setOnClose not implemented');
  }

  setOnConnect(callback: () => void): void {
    console.error('HybridTransport.setOnConnect not implemented');
  }

  readonly droppedBatchCount = 0
}