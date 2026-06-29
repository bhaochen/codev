/**
 * SSE Transport
 * This transport uses Server-Sent Events for communication
 */

export class SSETransport {
  constructor() {
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
}