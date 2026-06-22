/**
 * End-to-end HTTP flow test — simulates what the Tauri frontend does
 * with the browser VAD + server STT architecture:
 *   1. POST /voice/stt-segment  → send audio buffer for transcription
 *   2. Server transcribes and enqueues text to CLI
 *   3. POST /voice/start + /voice/stop  → push-to-talk mode
 *
 * Uses mocked STT so it runs in any environment.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { friendService } from '../FriendService.js';
import { setPrefs } from '../prefs.js';
import { handleFriendApi, setFriendServerInfo } from '../../server/api/friend.js';
import { getCommandQueue, resetCommandQueue } from '../../utils/messageQueueManager.js';

setFriendServerInfo('127.0.0.1', 3456);

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

function makeRequest(method: string, path: string, body?: unknown): Request {
  const url = new URL(path, 'http://127.0.0.1:3456');
  const init: RequestInit = { method };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(url.toString(), init);
}

function apiUrl(path: string): URL {
  return new URL(path, 'http://127.0.0.1:3456');
}

async function jsonResponse(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// ════════════════════════════════════════════════════════════════
// Mocks
// ════════════════════════════════════════════════════════════════

function createMockSttFactory() {
  let counter = 0;
  return async () => {
    const myId = ++counter;
    return {
      send: () => {},
      finalize: async () => {
        await new Promise(r => setTimeout(r, 50));
        (friendService as any).captureTranscripts.push(`[mock stt result #${myId}]`);
      },
      close: () => {},
    };
  };
}

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('E2E HTTP flow (browser VAD + server STT)', () => {
  let origStartStt: any;

  beforeEach(() => {
    resetCommandQueue();
    setPrefs({ sttProvider: 'groq' });
    origStartStt = (friendService as any).startSttConnection;
    (friendService as any).startSttConnection = createMockSttFactory();
  });

  afterEach(async () => {
    try { await friendService.stopVoiceCapture(); } catch {}
    (friendService as any).startSttConnection = origStartStt;
    resetCommandQueue();
  });

  test(
    'POST /voice/stt-segment → transcribes and enqueues via sendText()',
    async () => {
      // Create a WAV audio buffer (44-byte header + 16000 samples of silence)
      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(36 + 16000 * 2, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20); // PCM
      wavHeader.writeUInt16LE(1, 22); // mono
      wavHeader.writeUInt32LE(16000, 24); // sample rate
      wavHeader.writeUInt32LE(32000, 28); // byte rate
      wavHeader.writeUInt16LE(2, 32); // block align
      wavHeader.writeUInt16LE(16, 34); // bits per sample
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(16000 * 2, 40);

      const audioData = Buffer.alloc(16000 * 2, 128); // silence
      const fullAudio = Buffer.concat([wavHeader, audioData]);

      // Send as application/octet-stream
      const url = new URL('http://127.0.0.1:3456/plugins/friend/voice/stt-segment');
      const req = new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: fullAudio,
      });

      const res = await handleFriendApi(req, url);
      const data = await jsonResponse(res);

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(typeof data.text).toBe('string');
      expect((data.text as string).length).toBeGreaterThan(0);

      // Verify text was enqueued to CLI via sendText()
      await new Promise(r => setTimeout(r, 10)); // let async sendText() enqueue
      const queue = getCommandQueue();
      expect(queue.length).toBeGreaterThan(0);
      expect(queue[0].value).toContain('[mock stt result');
      expect(queue[0].origin?.server).toBe('friend');
    },
    10000,
  );

  test(
    'POST /voice/start → /voice/stop → push-to-talk cycle',
    async () => {
      const startRes = await handleFriendApi(
        makeRequest('POST', '/plugins/friend/voice/start'),
        apiUrl('/plugins/friend/voice/start'),
      );
      expect(startRes.status).toBe(200);

      // Let it "capture" briefly
      await new Promise(r => setTimeout(r, 200));

      const stopRes = await handleFriendApi(
        makeRequest('POST', '/plugins/friend/voice/stop'),
        apiUrl('/plugins/friend/voice/stop'),
      );
      const stopData = await jsonResponse(stopRes);
      expect(stopRes.status).toBe(200);
      expect(typeof stopData.text).toBe('string');
    },
    15000,
  );
});
