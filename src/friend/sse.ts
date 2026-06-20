/**
 * SSE client registry and typed broadcast for Friend VRM avatar.
 *
 * Uses Bun ReadableStream-based SSE (not Node http.ServerResponse),
 * compatible with the VersperClaw Bun.serve() infrastructure.
 */

type SseClient = {
  id: string;
  write: (data: string) => void;
  close: () => void;
};

const sseClients = new Set<SseClient>();

let clientIdCounter = 0;

/**
 * Register a new SSE client.
 */
export function addSseClient(client: SseClient): void {
  sseClients.add(client);
}

export function removeSseClient(client: SseClient): void {
  sseClients.delete(client);
}

export function getSseClientCount(): number {
  return sseClients.size;
}

export function createSseClientId(): string {
  return `sse-${++clientIdCounter}-${Date.now()}`;
}

export type VrmBroadcastPayload = {
  text?: string;
  emotion?: string;
  emotionIntensity?: number;
  audioUrl?: string;
  audioIndex?: number;
  clearText?: boolean;
  imageUrl?: string;
  moodDelta?: number;
  moodIndex?: number;
  sendFirstTts?: boolean;
  appendText?: boolean;
  replyDone?: boolean;
};

export function broadcastToVrm(payload: VrmBroadcastPayload) {
  if (sseClients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  const dead: SseClient[] = [];
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      dead.push(client);
    }
  }
  for (const client of dead) {
    sseClients.delete(client);
  }
}

/**
 * Create a Bun-compatible SSE response (ReadableStream).
 * Registers a client that the tools and API handlers can broadcast to.
 */
export function createSseResponse(): Response {
  const clientId = createSseClientId();
  let cleanupCalled = false;
  let sseClient: SseClient | undefined;

  const stream = new ReadableStream({
    start(controller) {
      sseClient = {
        id: clientId,
        write: (data: string) => {
          controller.enqueue(new TextEncoder().encode(data));
        },
        close: () => {
          try { controller.close(); } catch { /* already closed */ }
        },
      };

      addSseClient(sseClient);

      // Send initial newline to establish connection
      sseClient.write('\n');
    },
    cancel() {
      if (!cleanupCalled) {
        cleanupCalled = true;
        if (sseClient) {
          removeSseClient(sseClient);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
