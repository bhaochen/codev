/**
 * Voice capture tests for FriendService (push-to-talk mode).
 *
 * Tests:
 *   1. startVoiceCapture → stopVoiceCapture returns transcript
 *   2. TranscribeAudioSegment sends text to CLI queue
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { friendService } from '../FriendService.js';
import { setPrefs } from '../prefs.js';
import { getCommandQueue, resetCommandQueue } from '../../utils/messageQueueManager.js';

function createMockSttConnectionFactory() {
  let counter = 0;
  return async () => {
    const myId = ++counter;
    return {
      send: () => {},
      finalize: async () => {
        await new Promise(r => setTimeout(r, 50));
        const fs = friendService as any;
        fs.captureTranscripts.push(`[mock transcript #${myId}]`);
      },
      close: () => {},
    };
  };
}

describe('Voice capture (push-to-talk)', () => {
  let origStartStt: any;
  let origAudioCapture: any;

  beforeEach(() => {
    resetCommandQueue();
    setPrefs({ sttProvider: 'groq' });
    origStartStt = (friendService as any).startSttConnection;
    origAudioCapture = (friendService as any).audioCapture;
    (friendService as any).startSttConnection = createMockSttConnectionFactory();
    // Mock audio capture to avoid spawning arecord/parecord
    (friendService as any).audioCapture = {
      startRecording: async () => true,
      stopRecording: async () => {},
      isRecording: () => false,
    };
  });

  afterEach(async () => {
    try { await friendService.stopVoiceCapture(); } catch {}
    (friendService as any).startSttConnection = origStartStt;
    (friendService as any).audioCapture = origAudioCapture;
    resetCommandQueue();
  });

  test(
    'transcribeAudioSegment enqueues text via sendText()',
    async () => {
      const audioBuf = Buffer.alloc(16000); // 1s of silence @ 16kHz 16-bit
      const transcript = await friendService.transcribeAudioSegment(audioBuf);

      expect(transcript).toContain('[mock transcript');
      await new Promise(r => setTimeout(r, 10)); // let async sendText() enqueue
      const queue = getCommandQueue();
      expect(queue.length).toBeGreaterThan(0);
      expect(queue[0].value).toContain('[mock transcript');
      expect(queue[0].origin?.server).toBe('friend');
    },
    10000,
  );

  test(
    'startVoiceCapture + stopVoiceCapture returns transcript',
    async () => {
      await friendService.startVoiceCapture();

      await new Promise(r => setTimeout(r, 500));

      const transcript = await friendService.stopVoiceCapture();
      expect(typeof transcript).toBe('string');
    },
    15000,
  );
});
