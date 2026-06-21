/**
 * FriendService — in-process VRM companion brain service.
 *
 * Mirror of FeishuService pattern:
 *   - Singleton, runs in the main CLI process
 *   - subscribe()/subscribeToInbound() for React external store sync
 *   - enqueue() with origin tracking for message submission
 *   - In-process audio capture via cpal (src/services/voice.ts)
 *   - SSE broadcast for VRM display commands
 *
 * Eliminates the need for:
 *   - A separate background server subprocess (port 3456)
 *   - A CLI SDK subprocess (conversationService.startSession)
 *   - Server-side arecord/parecord audio capture
 */

import { broadcastToVrm, type VrmBroadcastPayload } from './sse.js';
import { getPrefs } from './prefs.js';
import { stripForTts } from './text-utils.js';
import { edgeTts, qwenTts, registerAudioFile } from './tts.js';
import { splitSentences } from './text-utils.js';

// ── Types ──────────────────────────────────────────────────────────────

export type FriendServiceState = {
  status: 'stopped' | 'starting' | 'running' | 'error';
  lastError?: string;
  /** Number of active SSE display clients */
  displayClientCount?: number;
  /** Current capture status (for voice call interim polling) */
  captureStatus?: { capturing: boolean; interimText?: string };
};

type Listener = () => void;

/** Inbound event for bridge hook consumption */
export type FriendInboundEvent = {
  text: string;
};

type InboundListener = (event: FriendInboundEvent) => void;

// ── Audio capture types (cpal wrapper) ─────────────────────────────────

type AudioCaptureProvider = {
  startRecording(
    onData: (chunk: Buffer) => void,
    onEnd: () => void,
  ): Promise<boolean>;
  stopRecording(): Promise<void>;
  isRecording(): boolean;
};

// ── Service implementation ─────────────────────────────────────────────

class FriendService {
  private listeners = new Set<Listener>();
  private inboundListeners = new Set<InboundListener>();
  private state: FriendServiceState = { status: 'stopped' };
  /** Audio capture in progress? */
  private capturing = false;
  /** Accumulated STT text chunks during capture */
  private captureTranscripts: string[] = [];
  /** Interim (non-final) text during active capture */
  private captureInterimText = '';
  /** Resolver for the current stopVoiceCapture() call */
  private captureResolver: ((text: string) => void) | null = null;
  /** Lazy-loaded cpal audio capture module */
  private audioCapture: AudioCaptureProvider | null = null;
  /** Active STT connection (Anthropic/Doubao/Whisper) during capture */
  private sttConnection: { send: (chunk: Buffer) => void; finalize: () => Promise<void>; close: () => void } | null = null;

  // ── React sync external store interface ──────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeToInbound(listener: InboundListener): () => void {
    this.inboundListeners.add(listener);
    return () => this.inboundListeners.delete(listener);
  }

  getStateSnapshot(): FriendServiceState {
    return this.state;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.state.status === 'running') return;

    this.setState({ status: 'starting', lastError: undefined });

    try {
      // Pre-warm cpal audio module (loaded on first use)
      // The voice service lazy-loads audio-capture-napi, so the first
      // capture will incur the ~1s dlopen penalty regardless.

      this.setState({ status: 'running' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', lastError: msg });
      throw err;
    }
  }

  async stop(): Promise<void> {
    // Stop any active capture
    if (this.capturing) {
      await this.stopVoiceCapture().catch(() => {});
    }

    this.audioCapture = null;
    this.sttConnection = null;

    if (this.state.status !== 'stopped') {
      this.setState({ status: 'stopped' });
    }
  }

  // ── Text relay via messageQueueManager.enqueue() ─────────────────────

  /**
   * Send text through the main CLI conversation.
   * Mirrors FeishuService's enqueue() pattern with origin tracking.
   */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Notify inbound listeners (bridge hook uses this for turn tracking)
    for (const listener of this.inboundListeners) {
      listener({ text: trimmed });
    }

    // Dynamically import enqueue to avoid circular deps
    import('../utils/messageQueueManager.js').then(({ enqueue }) => {
      enqueue({
        value: trimmed,
        mode: 'prompt',
        skipSlashCommands: true,
        bridgeOrigin: true,
        origin: { kind: 'channel', server: 'friend' },
      });
    }).catch((err) => {
      console.error('[FriendService] enqueue failed:', err);
    });
  }

  // ── Voice capture ────────────────────────────────────────────────────

  /**
   * Start in-process voice capture using cpal.
   * Audio is forwarded to the configured STT provider.
   * Returns when capture-started confirmation is received.
   */
  async startVoiceCapture(): Promise<void> {
    if (this.capturing) return;

    const prefs = getPrefs();
    const provider = prefs.sttProvider || 'browser';
    const language = prefs.sttLanguage || 'zh';

    this.captureTranscripts = [];
    this.captureInterimText = '';
    this.capturing = true;

    try {
      // 1. Start STT provider connection
      const conn = await this.startSttConnection(provider, language);
      this.sttConnection = conn;

      // 2. Load audio capture module (cpal)
      const audio = await this.loadAudioCapture();

      // 3. Start cpal recording — chunks go to STT
      const ok = await audio.startRecording(
        (chunk: Buffer) => {
          this.sttConnection?.send(chunk);
        },
        () => {
          // Capture ended (user stop or silence detection)
        },
      );

      if (!ok) {
        // Fallback: try arecord as subprocess
        this.capturing = false;
        throw new Error('Native audio capture unavailable');
      }
    } catch (err) {
      this.capturing = false;
      this.sttConnection?.close();
      this.sttConnection = null;
      throw err;
    }
  }

  /**
   * Stop voice capture and return the accumulated transcript.
   */
  async stopVoiceCapture(): Promise<string> {
    if (!this.capturing) return '';

    this.capturing = false;

    // Stop cpal recording
    if (this.audioCapture) {
      await this.audioCapture.stopRecording().catch(() => {});
    }

    // Finalize STT connection
    const conn = this.sttConnection;
    this.sttConnection = null;

    if (conn) {
      try {
        await conn.finalize();
        conn.close();
      } catch {
        // ignore finalization errors
      }
    }

    const transcript = this.captureTranscripts.join('');
    this.captureTranscripts = [];
    this.captureInterimText = '';
    this.setState({ captureStatus: { capturing: false } });
    return transcript;
  }

  /**
   * Get current capture status (for voice call interim polling).
   */
  getCaptureStatus(): { capturing: boolean; interimText?: string } {
    return this.state.captureStatus ?? { capturing: false };
  }

  // ── Response broadcast (called by useFriendBridge) ───────────────────

  /**
   * Broadcast AI response to the VRM display layer via SSE.
   * Generates TTS audio for completed sentences and sends
   * emotion/action commands alongside text.
   */
  async broadcastResponse(text: string): Promise<void> {
    if (!text.trim()) return;

    const prefs = getPrefs();

    // Send the text — the frontend TextBubble splits and displays it
    broadcastToVrm({ text });

    // Generate TTS for the full response if enabled
    if (prefs.ttsEnabled) {
      try {
        const audioUrl = await this.generateTts(text);
        if (audioUrl) {
          broadcastToVrm({ audioUrl, sendFirstTts: true });
        }
      } catch (err) {
        console.warn('[FriendService] TTS generation failed:', err);
      }
    }

    // Signal reply done
    broadcastToVrm({ replyDone: true });
  }

  /**
   * Broadcast VRM emotion/action command.
   */
  broadcastVrm(payload: VrmBroadcastPayload): void {
    broadcastToVrm(payload);
  }

  // ── Private: STT connection factory ──────────────────────────────────

  private async startSttConnection(
    provider: string,
    language: string,
  ): Promise<{ send: (chunk: Buffer) => void; finalize: () => Promise<void>; close: () => void }> {
    const callbacks = {
      onTranscript: (text: string, isFinal: boolean) => {
        if (isFinal) {
          this.captureTranscripts.push(text);
          this.captureInterimText = '';
        } else {
          this.captureInterimText = text;
        }
        // Update state for status polling
        this.setState({
          captureStatus: { capturing: true, interimText: this.captureInterimText },
        });
      },
      onError: (_error: string) => {},
      onClose: () => {},
      onReady: (_conn: any) => {},
    };

    switch (provider) {
      case 'anthropic': {
        const { connectVoiceStream, isVoiceStreamAvailable } = await import(
          '../services/voiceStreamSTT.js'
        );
        if (!isVoiceStreamAvailable()) {
          throw new Error('Anthropic Voice Stream not available');
        }
        return await connectVoiceStream(callbacks, { language, keyterms: ['code', 'versperclaw'] });
      }

      case 'local': {
        const { connectLocalWhisperStream, preloadWhisperModel } = await import(
          '../services/voice/whisperSTT.js'
        );
        await preloadWhisperModel({ language });
        return await connectLocalWhisperStream(callbacks, { language });
      }

      case 'doubao': {
        const { connectDoubaoStream } = await import('../services/doubaoSTT.js');
        return await connectDoubaoStream(callbacks, { language: language || 'zh' });
      }

      default:
        throw new Error(`Unknown STT provider: ${provider}`);
    }
  }

  // ── Private: Audio capture (cpal wrapper) ────────────────────────────

  private async loadAudioCapture(): Promise<AudioCaptureProvider> {
    if (this.audioCapture) return this.audioCapture;

    // Try native cpal module first
    try {
      const mod = await import('audio-capture-napi').catch(() => null);
      if (mod && typeof mod.startNativeRecording === 'function') {
        this.audioCapture = {
          startRecording: async (onData, onEnd) => {
            try {
              return mod.startNativeRecording(
                (data: Buffer) => onData(data),
                () => onEnd(),
              ) as boolean;
            } catch {
              return false;
            }
          },
          stopRecording: async () => {
            if (mod.isNativeRecordingActive()) {
              mod.stopNativeRecording();
            }
          },
          isRecording: () => mod.isNativeRecordingActive() as boolean,
        };
        return this.audioCapture;
      }
    } catch {
      // cpal unavailable, fall through
    }

    // Fallback: spawn arecord/parecord as subprocess
    const { spawn } = await import('node:child_process');
    let captureProc: import('node:child_process').ChildProcess | null = null;

    this.audioCapture = {
      startRecording: async (onData, _onEnd) => {
        for (const tool of ['parecord', 'arecord']) {
          try {
            const args = tool === 'parecord'
              ? ['--raw', '--rate=16000', '--format=s16le', '--channels=1', '--latency-msec=20']
              : ['-r', '16000', '-f', 'S16_LE', '-c', '1', '-t', 'raw', '-q', '-'];
            const proc = spawn(tool, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            if (proc.pid !== undefined) {
              captureProc = proc;
              proc.stdout?.on('data', onData);
              proc.on('exit', () => { captureProc = null; });
              return true;
            }
          } catch {
            continue;
          }
        }
        return false;
      },
      stopRecording: async () => {
        if (captureProc) {
          captureProc.kill('SIGTERM');
          setTimeout(() => {
            try { captureProc?.kill('SIGKILL'); } catch {}
          }, 2000);
          captureProc = null;
        }
      },
      isRecording: () => captureProc !== null,
    };

    return this.audioCapture;
  }

  // ── Private: TTS generation ──────────────────────────────────────────

  private async generateTts(text: string): Promise<string | undefined> {
    const prefs = getPrefs();
    if (!prefs.ttsEnabled) return undefined;

    const cleanText = stripForTts(text);
    if (!cleanText) return undefined;

    let result: { success: boolean; audioPath?: string; error?: string };
    if (prefs.provider === 'qwen' && prefs.qwenKey) {
      result = await qwenTts({
        text: cleanText,
        apiKey: prefs.qwenKey,
        voice: prefs.voice,
        model: prefs.qwenModel,
        language: prefs.language,
      });
    } else {
      result = await edgeTts({ text: cleanText, voice: prefs.voice });
    }

    if (result.success && result.audioPath) {
      return registerAudioFile(result.audioPath);
    }

    return undefined;
  }

  // ── Private: state management ────────────────────────────────────────

  private setState(next: Partial<FriendServiceState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
}

// Singleton
export const friendService = new FriendService();
