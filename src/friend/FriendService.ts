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
import { edgeTts, qwenTts, registerAudioFile, getAudioFile } from './tts.js';
import { splitSentences } from './text-utils.js';
import { SileroVad } from './voice/vad-service.js';
import { readFileSync } from 'node:fs';

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
  /** STT provider/language cached for connection re-creation during segmentation */
  private captureProvider = '';
  private captureLanguage = '';
  /** Guard against concurrent flush calls */
  private _flushing = false;
  /** Silero VAD instance (real ML-based voice activity detection) */
  private vadInstance: SileroVad | null = null;
  /** When muted, audio from arecord is not forwarded to STT or VAD (prevents echo) */
  private muted = false;
  /** Timer to automatically unmute after estimated TTS playback */
  private muteTimer: ReturnType<typeof setTimeout> | null = null;

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
      // Pre-warm Silero VAD (loads ONNX model + onnxruntime-web WASM)
      if (!this.vadInstance) {
        const vad = new SileroVad({
          onSpeechStart: () => {},
          onSpeechEnd: (_audio) => {
            this._flushVadSegment().catch((e) =>
              console.error('[FriendService] VAD segment flush error:', e),
            );
          },
        });
        vad.init().then(() => {
          this.vadInstance = vad;
        }).catch((e) => {
          console.warn('[FriendService] VAD init failed (non-fatal, voice capture falls back to F2-only):', e);
        });
      }

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
   * Wraps initialization in a timeout (12s) to prevent hanging
   * when STT provider or audio device is unavailable.
   */
  async startVoiceCapture(): Promise<void> {
    if (this.capturing) return;

    const prefs = getPrefs();
    let provider = prefs.sttProvider;
    const language = prefs.sttLanguage || 'zh';

    // Auto-detect STT provider if not configured or set to 'browser' (not available in WebKitGTK)
    if (!provider || provider === 'browser') {
      provider = await this.detectAvailableSttProvider();
    }

    this.captureTranscripts = [];
    this.captureInterimText = '';
    this.capturing = true;

    try {
      // Wrap the whole initialization in a 12s timeout to avoid hanging
      // when STT provider or audio device is unavailable.
      await this.withTimeout(
        this._initVoiceCapture(provider, language),
        12000,
        `Voice initialization timed out. Check that your microphone is accessible and STT provider "${provider}" is configured correctly.`,
      );
    } catch (err) {
      this.capturing = false;
      this.sttConnection?.close();
      this.sttConnection = null;
      throw err;
    }
  }

  /**
   * Internal voice capture initialization (STT connection + audio capture).
   * Separated so startVoiceCapture() can wrap it with a timeout.
   */
  private async _initVoiceCapture(
    provider: string,
    language: string,
  ): Promise<void> {
    this.captureProvider = provider;
    this.captureLanguage = language;

    // 1. Start STT provider connection (with inner 8s timeout)
    const conn = await this.startSttConnectionWithTimeout(provider, language);
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
      throw new Error('Native audio capture unavailable');
    }

    // 4. Start Silero VAD for real-time speech-end detection
    // audio chunks flow to VAD via the arecord data callback (see loadAudioCapture)
    if (this.vadInstance) {
      try {
        this.vadInstance.start();
      } catch (e) {
        console.warn('[FriendService] VAD start error (non-fatal):', e);
      }
    }
  }

  /**
   * Flush the current STT segment and start a new one, triggered by
   * Silero VAD's onSpeechEnd callback.
   *
   * The audio from the just-ended speech segment has already been sent
   * to the STT connection. We swap to a fresh connection so the next
   * speech segment starts clean.
   */
  private async _flushVadSegment(): Promise<void> {
    if (this._flushing || !this.capturing) return;
    this._flushing = true;
    try {
      const oldConn = this.sttConnection;
      if (!oldConn) return;

      // 1. Create a new STT connection for ongoing audio
      const newConn = await this.startSttConnectionWithTimeout(
        this.captureProvider,
        this.captureLanguage,
      );
      this.sttConnection = newConn;

      // 2. Finalize old connection (sends buffered audio to STT provider)
      await oldConn.finalize().catch(() => {});
      oldConn.close();

      // 3. Send accumulated transcript to the CLI conversation
      const transcript = this.captureTranscripts.join('').trim();
      if (transcript) {
        this.captureTranscripts = [];
        this.sendText(transcript);
      }
    } catch (err) {
      console.error('[FriendService] _flushVadSegment error:', err);
    } finally {
      this._flushing = false;
    }
  }

  /** Race a promise against a timeout */
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(message)), ms),
      ),
    ]);
  }

  /**
   * Auto-detect the first available STT provider.
   * Tries: Groq Whisper (cloud, API key) → local Whisper → Anthropic Voice Stream → Doubao ASR
   */
  private async detectAvailableSttProvider(): Promise<string> {
    console.log('[FriendService] detectAvailableSttProvider: checking available providers...');

    // Check Groq API key first (fastest — no Python, just a REST call)
    // Keys are resolved from: prefs → process.env → ~/.claude/settings.json
    try {
      const { isGroqAvailable } = await import('../services/voice/groqSTT.js');
      if (isGroqAvailable()) {
        console.log('[FriendService] detectAvailableSttProvider: Groq API key found');
        return 'groq';
      }
    } catch { /* ignore */ }

    // Check local Whisper (no external API keys needed)
    try {
      const { checkLocalWhisperAvailable } = await import(
        '../services/voice/whisperSTT.js'
      );
      const avail = await checkLocalWhisperAvailable();
      console.log('[FriendService] detectAvailableSttProvider: local Whisper available:', avail);
      if (avail) {
        return 'local';
      }
    } catch (e) {
      console.warn('[FriendService] detectAvailableSttProvider: local whisper check failed:', e);
    }

    // Check Anthropic Voice Stream
    try {
      const { isVoiceStreamAvailable } = await import(
        '../services/voiceStreamSTT.js'
      );
      if (isVoiceStreamAvailable()) {
        return 'anthropic';
      }
    } catch { /* skip */ }

    // Check Doubao credentials file
    try {
      const path = await import('node:path');
      const fs = await import('node:fs');
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const credsPath = path.join(homeDir, '.claude', 'tts', 'doubao', 'credentials.json');
      if (fs.existsSync(credsPath)) {
        return 'doubao';
      }
    } catch { /* skip */ }

    throw new Error(
      'No STT provider available. Install local Whisper:\n' +
      '  pip install openai-whisper\n\n' +
      'Or configure an STT provider in Friend settings (Settings → STT Provider).',
    );
  }

  /**
   * Start STT connection with a timeout to prevent hanging
   * when the provider is unavailable (e.g. Python Whisper not installed).
   */
  private async startSttConnectionWithTimeout(
    provider: string,
    language: string,
  ): Promise<{ send: (chunk: Buffer) => void; finalize: () => Promise<void>; close: () => void }> {
    const timeoutMs = 8000;
    const result = await Promise.race([
      this.startSttConnection(provider, language),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `STT provider "${provider}" timed out after ${timeoutMs / 1000}s.` +
                  (provider === 'local'
                    ? '\nInstall local Whisper: pip install openai-whisper'
                    : ''),
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
    return result;
  }

  /**
   * Stop voice capture and return the accumulated transcript.
   */
  async stopVoiceCapture(): Promise<string> {
    return this._stopCapture();
  }

  /**
   * Internal: stop audio capture + finalize STT, return transcript.
   */
  private async _stopCapture(): Promise<string> {
    console.log(`[FriendService] _stopCapture: capturing=${this.capturing} sttConnection=${this.sttConnection ? 'exists' : 'null'}`);
    if (!this.capturing) return '';

    // Stop audio recording first (no more audio → no more STT/VAD input)
    if (this.audioCapture) {
      await this.audioCapture.stopRecording().catch(() => {});
    }

    this.capturing = false;

    // Clear mute state
    this.clearMute();

    // Reset VAD state silently (don't fire onSpeechEnd — we're finalizing below)
    if (this.vadInstance) {
      try {
        this.vadInstance.reset();
      } catch { /* ignore */ }
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

    // Send any remaining transcript to CLI before returning
    const remaining = this.captureTranscripts.join('').trim();
    if (remaining) {
      this.sendText(remaining);
    }

    const transcript = this.captureTranscripts.join('');
    console.log(`[FriendService] _stopCapture: transcript="${transcript}" (len=${transcript.length})`);
    this.captureTranscripts = [];
    this.captureInterimText = '';
    this.setState({ captureStatus: { capturing: false } });
    return transcript;
  }

  /**
   * Get current capture status (for push-to-talk mode).
   */
  getCaptureStatus(): { capturing: boolean; interimText?: string } {
    const status = this.state.captureStatus ?? { capturing: false };
    return { ...status };
  }

  /**
   * Transcribe an audio buffer (PCM/WAV) using the configured STT provider
   * and send the resulting text to the CLI conversation.
   *
   * Called by the HTTP endpoint when the browser VAD detects a speech segment.
   */
  async transcribeAudioSegment(audioBuffer: Buffer): Promise<string> {
    const prefs = getPrefs();
    let provider = prefs.sttProvider;
    if (!provider || provider === 'browser') {
      provider = await this.detectAvailableSttProvider();
    }

    // Create a temporary STT connection just for this segment
    const conn = await this.startSttConnectionWithTimeout(
      provider,
      prefs.sttLanguage || 'zh',
    );

    try {
      conn.send(audioBuffer);
      await conn.finalize();
      conn.close();
    } catch (err) {
      conn.close();
      throw err;
    }

    // Get transcript from the finalization callback
    const transcript = this.captureTranscripts.join('');
    this.captureTranscripts = [];

    if (transcript.trim()) {
      this.sendText(transcript);
    }

    return transcript;
  }

  /**
   * Mute audio capture for the exact duration of the TTS audio file.
   * Audio from arecord will not be forwarded to STT or VAD while muted.
   * Automatically unmutes when the TTS audio would have finished playing.
   */
  private muteForTts(audioId: string, text: string): void {
    if (!this.capturing) return;

    // Clear any existing mute timer
    if (this.muteTimer) {
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }

    this.muted = true;

    // Pause VAD so it doesn't accumulate stale audio
    this.vadInstance?.pause();

    // Parse the actual MP3 duration for precise mute timing
    let muteMs = this.getMp3DurationMs(audioId);
    if (muteMs <= 0) {
      // Fallback estimate if parsing fails
      muteMs = Math.max(3000, Math.round(text.length * 100) + 1500);
    }

    this.muteTimer = setTimeout(() => {
      this.muted = false;
      this.muteTimer = null;
      // Resume VAD with fresh state (buffer cleared by pause())
      this.vadInstance?.start();
    }, muteMs);
  }

  /** Parse MP3 file to get exact audio duration in milliseconds.
   *
   * Finds the first two frame syncs to determine the real frame size,
   * then counts frames using that stride. Works for CBR output (Edge TTS)
   * without relying on error-prone bitrate lookup tables.
   */
  private getMp3DurationMs(audioId: string): number {
    const filePath = getAudioFile(audioId);
    if (!filePath) return 0;
    let buf: Buffer;
    try { buf = readFileSync(filePath); } catch { return 0; }
    if (buf.length < 100) return 0;

    const isSync = (p: number) =>
      p + 1 < buf.length && buf[p] === 0xff && (buf[p + 1] & 0xe0) === 0xe0;

    let offset = 0;

    // Skip ID3v2 tag
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      offset = 10 +
        ((buf[6] & 0x7f) << 21) |
        ((buf[7] & 0x7f) << 14) |
        ((buf[8] & 0x7f) << 7) |
        (buf[9] & 0x7f);
    }

    // Find first two syncs to measure actual frame stride
    let firstSync = -1;
    let secondSync = -1;
    for (let i = offset; i < buf.length - 3; i++) {
      if (isSync(i)) {
        if (firstSync === -1) firstSync = i;
        else { secondSync = i; break; }
      }
    }
    if (firstSync === -1 || secondSync === -1) return 0;

    const frameSize = secondSync - firstSync; // real stride (CBR)
    if (frameSize < 20) return 0;

    // Parse frame header for sample rate and samples-per-frame
    const h =
      (buf[firstSync] << 24) |
      (buf[firstSync + 1] << 16) |
      (buf[firstSync + 2] << 8) |
      buf[firstSync + 3];
    const version = (h >> 19) & 0x3;
    const sampleRateIdx = (h >> 10) & 0x3;
    if (sampleRateIdx === 3) return 0;

    const srTable: Record<number, number> = {
      3: [44100, 48000, 32000][sampleRateIdx],
      2: [22050, 24000, 16000][sampleRateIdx],
      0: [11025, 12000, 8000][sampleRateIdx],
    };
    const sampleRate = srTable[version];
    if (!sampleRate) return 0;

    const isMpeg1 = version === 3;
    const spf = isMpeg1 ? 1152 : 576;

    // Count frames using stride
    let frames = 0;
    for (let pos = firstSync; pos + 3 < buf.length; pos += frameSize) {
      // Sanity check: verify sync word
      if (!isSync(pos)) {
        // Frame may have been corrupted; scan forward to next sync
        while (pos < buf.length - 3 && !isSync(pos)) pos++;
        if (pos >= buf.length - 3) break;
      }
      frames++;
    }

    return Math.round((frames * spf) / sampleRate * 1000);
  }

  /** Clear mute state immediately */
  private clearMute(): void {
    if (this.muteTimer) {
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }
    this.muted = false;
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
        const audioId = await this.generateTts(text);
        if (audioId) {
          const fullUrl = `http://127.0.0.1:3456/plugins/friend/audio/${audioId}`;
          broadcastToVrm({ audioUrl: fullUrl, sendFirstTts: true });

          // Mute capture for the exact TTS audio duration
          if (this.capturing) {
            this.muteForTts(audioId, text);
          }
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

      case 'groq': {
        const { connectGroqStream } = await import(
          '../services/voice/groqSTT.js'
        );
        return await connectGroqStream(callbacks, { language });
      }

      default:
        throw new Error(`Unknown STT provider: ${provider}`);
    }
  }

  // ── Private: Audio capture (arecord/parecord subprocess) ──────────────

  private async loadAudioCapture(): Promise<AudioCaptureProvider> {
    if (this.audioCapture) return this.audioCapture;

    // Use subprocess-based capture (arecord/parecord) on all platforms.
    // Skipping the native cpal module because its synchronous NAPI call
    // can block the event loop if ALSA initialization hangs, and there
    // is no way to timeout a native binding call from JS.
    const { spawn } = await import('node:child_process');
    let captureProc: import('node:child_process').ChildProcess | null = null;

    this.audioCapture = {
      startRecording: async (onData, _onEnd) => {
        for (const tool of ['arecord', 'parecord']) {
          try {
            const args = tool === 'arecord'
              ? ['-D', 'default', '-r', '16000', '-f', 'S16_LE', '-c', '1', '-t', 'raw', '-q']
              : ['--raw', '--rate=16000', '--format=s16le', '--channels=1', '--latency-msec=20'];
            const proc = spawn(tool, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            if (proc.pid === undefined) continue;

            // Verify the tool actually produces audio data within 500ms.
            // Some tools (e.g. parecord without PulseAudio) spawn successfully
            // but exit immediately without any output — catch that here.
            let dataArrived = false;
            let verifyTimer: ReturnType<typeof setTimeout> | null = null;

            const verified = await new Promise<boolean>((resolve) => {
              const feedAudio = (c: Buffer) => {
                // Skip when muted — prevents AI TTS echo from re-entering STT/VAD
                if (this.muted) return;

                // Forward to STT connection
                onData(c);

                // Forward to VAD for speech activity detection
                if (this.vadInstance) {
                  const float32 = new Float32Array(c.length / 2);
                  for (let i = 0; i < float32.length; i++) {
                    float32[i] = c.readInt16LE(i * 2) / 32768;
                  }
                  this.vadInstance.processAudio(float32).catch(() => {});
                }
              };

              const dataHandler = (chunk: Buffer) => {
                dataArrived = true;
                if (verifyTimer) { clearTimeout(verifyTimer); }
                feedAudio(chunk);
                // Swap to the permanent handler for subsequent chunks
                proc.stdout?.removeListener('data', dataHandler);
                proc.stdout?.on('data', feedAudio);
                resolve(true);
              };
              proc.stdout?.on('data', dataHandler);

              // Process exited before producing data — mark as failed
              proc.on('exit', () => {
                if (!dataArrived) {
                  if (verifyTimer) { clearTimeout(verifyTimer); }
                  resolve(false);
                }
              });

              // No data within 500ms — assume failure
              verifyTimer = setTimeout(() => {
                if (!dataArrived) resolve(false);
              }, 500);
            });

            if (verified) {
              captureProc = proc;
              proc.on('exit', () => { captureProc = null; });
              return true;
            }

            // Verification failed — kill and try next tool
            proc.kill('SIGTERM');
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
