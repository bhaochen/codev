/**
 * SSE Transport - stub
 * Not implemented; preserves the type surface used by v2 replBridge.
 */

export class SSETransport {
  constructor(
    url: URL,
    headers?: Record<string, string>,
    sessionId?: string,
    _baseUrl?: unknown,
    initialSequenceNum?: number,
    getAuthHeaders?: () => Record<string, string>,
  ) {
    console.error('SSETransport not implemented');
  }

  async connect(): Promise<void> {
    console.error('SSETransport.connect not implemented');
  }

  async disconnect(): Promise<void> {
    console.error('SSETransport.disconnect not implemented');
  }

  async send(data: any): Promise<void> {
    console.error('SSETransport.send not implemented');
  }

  async receive(): Promise<any> {
    console.error('SSETransport.receive not implemented');
    return null;
  }

  setOnEvent(callback: (event: { event_id: string }) => void): void {
    console.error('SSETransport.setOnEvent not implemented');
  }

  setOnData(callback: (data: string) => void): void {
    console.error('SSETransport.setOnData not implemented');
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    console.error('SSETransport.setOnClose not implemented');
  }

  isClosedStatus(): boolean {
    return false
  }

  isConnectedStatus(): boolean {
    return false
  }

  getLastSequenceNum(): number {
    return 0
  }

  close(): void {
    console.error('SSETransport.close not implemented');
  }
}