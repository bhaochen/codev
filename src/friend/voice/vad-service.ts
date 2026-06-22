/**
 * Silero VAD service — real-time voice activity detection using onnxruntime-web WASM backend.
 *
 * Uses the Silero VAD legacy ONNX model (bundled with @ericedouard/vad-node-realtime).
 * onnxruntime-web (WASM) is used instead of onnxruntime-node (native addon) because
 * Bun does not support the native Node-API addon (crashes with segfault).
 *
 * Architecture:
 *   - Audio frames (512 samples @ 16kHz = 32ms) are fed to the Silero model
 *   - Speech probability is compared against configurable thresholds
 *   - A state machine tracks speech segments with redemption grace period
 *   - onSpeechEnd fires when sustained silence is detected
 */

import * as ort from 'onnxruntime-web';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface VadCallbacks {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onVADMisfire?: () => void;
  onFrameProcessed?: (prob: number, isSpeech: boolean) => void;
}

export interface VadOptions {
  /** Threshold above which a frame is considered speech (0-1). Default: 0.75 */
  positiveSpeechThreshold?: number;
  /** Threshold below which a frame is considered silence (0-1). Default: 0.50 */
  negativeSpeechThreshold?: number;
  /** Consecutive silence frames before onSpeechEnd fires. Default: 20 (~640ms) */
  redemptionFrames?: number;
  /** Minimum confirmed speech frames to avoid misfire. Default: 6 (~192ms) */
  minSpeechFrames?: number;
  /** Frames of pre-speech audio to include in onSpeechEnd segment. Default: 10 */
  preSpeechPadFrames?: number;
  /** Sample rate of input audio (must be 16000). Default: 16000 */
  sampleRate?: number;
  /** RMS energy threshold (0-1). Frames below this are treated as silence without inference. Default: 0.004 (~-48dBFS) */
  rmsThreshold?: number;
  /** Consecutive speech frames required to trigger speech start. Default: 10 (~320ms) — filters short noise bursts */
  preSpeechTriggerFrames?: number;
}

export class SileroVad {
  private session: ort.InferenceSession | null = null;
  private stateH: ort.Tensor<onnxruntime.TensorType> | null = null;
  private stateC: ort.Tensor<onnxruntime.TensorType> | null = null;
  private sr: ort.Tensor<onnxruntime.TensorType> | null = null;
  private initialized = false;
  private active = false;

  private readonly opts: Required<VadOptions>;
  private readonly callbacks: Required<VadCallbacks>;
  private readonly frameSize = 512; // Legacy Silero model: 512 samples @ 16kHz per frame

  // Audio accumulation buffer
  private buffer = new Float32Array(0);

  // Frame processor state machine
  private speaking = false;
  private redemptionCounter = 0;
  private speechFrameCount = 0;
  /** Consecutive speech frame count in pre-speech phase (fires speech on threshold) */
  private preSpeechCount = 0;
  private frameHistory: Array<{ frame: Float32Array; isSpeech: boolean }> = [];

  constructor(callbacks: VadCallbacks, opts?: VadOptions) {
    this.callbacks = {
      onSpeechStart: callbacks.onSpeechStart ?? (() => {}),
      onSpeechEnd: callbacks.onSpeechEnd ?? (() => {}),
      onVADMisfire: callbacks.onVADMisfire ?? (() => {}),
      onFrameProcessed: callbacks.onFrameProcessed ?? (() => {}),
    };
    this.opts = {
      positiveSpeechThreshold: opts?.positiveSpeechThreshold ?? 0.75,
      negativeSpeechThreshold: opts?.negativeSpeechThreshold ?? 0.50,
      redemptionFrames: opts?.redemptionFrames ?? 20,
      minSpeechFrames: opts?.minSpeechFrames ?? 6,
      preSpeechPadFrames: opts?.preSpeechPadFrames ?? 10,
      sampleRate: opts?.sampleRate ?? 16000,
      rmsThreshold: opts?.rmsThreshold ?? 0.004,
      preSpeechTriggerFrames: opts?.preSpeechTriggerFrames ?? 10,
    };
  }

  /**
   * Initialize the VAD: load ONNX model and configure onnxruntime-web WASM backend.
   * Must be called once before start().
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Point onnxruntime-web to the WASM binary files
    const wasmDir = resolveWasmDir();
    ort.env.wasm.wasmPaths = wasmDir + '/';

    // Load Silero VAD legacy ONNX model
    const modelPath = resolveModelPath();
    const modelBuffer = readFileSync(modelPath);
    this.session = await ort.InferenceSession.create(modelBuffer.buffer, {
      executionProviders: ['wasm'],
    });

    // Initialize LSTM state tensors (legacy: h=[2,1,64], c=[2,1,64])
    this.stateH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
    this.stateC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
    this.sr = new ort.Tensor('int64', [BigInt(this.opts.sampleRate)], [1]);

    this.initialized = true;
  }

  /** Start VAD processing */
  start(): void {
    this.active = true;
  }

  /** Pause VAD processing, ending any active speech segment */
  pause(): void {
    this.active = false;
    this.endSegment();
  }

  /**
   * Feed raw PCM audio (Float32Array, values -1..1, 16kHz) to the VAD.
   * Audio is buffered and processed in 512-sample frames.
   */
  async processAudio(audioData: Float32Array): Promise<void> {
    if (!this.active || !this.initialized || !this.session) return;

    // Append to internal buffer
    const tmp = new Float32Array(this.buffer.length + audioData.length);
    tmp.set(this.buffer);
    tmp.set(audioData, this.buffer.length);
    this.buffer = tmp;

    // Process complete 512-sample frames
    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.subarray(0, this.frameSize);
      this.buffer = this.buffer.subarray(this.frameSize);
      await this.processFrame(frame);
    }
  }

  /** Flush any remaining audio and end active speech segment */
  async flush(): Promise<void> {
    if (this.buffer.length > 0) {
      // Pad last partial frame with zeros
      const padded = new Float32Array(this.frameSize);
      padded.set(this.buffer);
      this.buffer = new Float32Array(0);
      await this.processFrame(padded);
    }
    this.endSegment();
  }

  /** Reset VAD state without destroying the session */
  reset(): void {
    this.buffer = new Float32Array(0);
    this.frameHistory = [];
    this.speaking = false;
    this.redemptionCounter = 0;
    this.speechFrameCount = 0;
    this.preSpeechCount = 0;
    this.stateH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
    this.stateC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
  }

  /** Clean up resources */
  destroy(): void {
    this.active = false;
    this.reset();
    if (this.session) {
      try { (this.session as any).dispose?.(); } catch { /* ignore */ }
      this.session = null;
    }
    this.initialized = false;
  }

  // ── Private: frame processing ──────────────────────────────────────────

  private async processFrame(frame: Float32Array): Promise<void> {
    if (!this.session || !this.stateH || !this.stateC || !this.sr) return;

    // ── 1. Energy pre-filter: compute RMS — skip Silero for low-energy noise ──
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      sumSq += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sumSq / frame.length);

    let prob: number;
    if (rms < this.opts.rmsThreshold) {
      prob = 0; // Below noise floor — mechanical noise, mic bump, room silence
    } else {
      // ── 2. Silero inference for speech probability ──
      try {
        const result = await this.session.run({
          input: new ort.Tensor('float32', frame, [1, this.frameSize]),
          sr: this.sr,
          h: this.stateH,
          c: this.stateC,
        });

        // Update LSTM state for next frame
        this.stateH = result.hn as ort.Tensor<onnxruntime.TensorType>;
        this.stateC = result.cn as ort.Tensor<onnxruntime.TensorType>;

        prob = (result.output as ort.Tensor<onnxruntime.TensorType>).data[0] as number;
      } catch (err) {
        console.error('[SileroVad] frame inference error:', err);
        return;
      }
    }

    const isSpeech = prob >= this.opts.positiveSpeechThreshold;
    const isSilence = prob < this.opts.negativeSpeechThreshold;

    this.callbacks.onFrameProcessed(prob, isSpeech);

    // ── 3. State machine ────────────────────────────────────────────
    if (this.speaking) {
      // In a confirmed speech segment
      if (isSilence) {
        this.redemptionCounter++;
        if (this.redemptionCounter >= this.opts.redemptionFrames) {
          this.endSpeech();
        }
      } else {
        this.redemptionCounter = 0;
      }
      this.speechFrameCount++;
      this.frameHistory.push({ frame: frame.slice(), isSpeech });
    } else if (isSpeech) {
      // Pre-speech phase: require consecutive speech frames to trigger
      this.preSpeechCount++;

      if (this.preSpeechCount >= this.opts.preSpeechTriggerFrames) {
        // Transition: silence → confirmed speech (sustained above threshold)
        this.speaking = true;
        this.redemptionCounter = 0;
        this.speechFrameCount = this.preSpeechCount;
        this.preSpeechCount = 0;
        this.frameHistory.push({ frame: frame.slice(), isSpeech: true });
        this.callbacks.onSpeechStart();
      }
    } else {
      // Not speech — discard any accumulated pre-speech frames
      this.preSpeechCount = 0;
    }
  }

  private endSpeech(): void {
    if (this.speechFrameCount < this.opts.minSpeechFrames) {
      this.callbacks.onVADMisfire();
    } else {
      // Build audio segment with pre-padding for context
      const total = this.frameHistory.length;
      const prePad = Math.min(this.opts.preSpeechPadFrames, total);
      const segFrames = this.frameHistory.slice(total - prePad - this.speechFrameCount, total);
      let totalSamples = 0;
      for (const f of segFrames) totalSamples += f.frame.length;
      const segment = new Float32Array(totalSamples);
      let offset = 0;
      for (const f of segFrames) {
        segment.set(f.frame, offset);
        offset += f.frame.length;
      }
      this.callbacks.onSpeechEnd(segment);
    }

    // Reset speech state
    this.speaking = false;
    this.redemptionCounter = 0;
    this.speechFrameCount = 0;
    this.frameHistory = [];
  }

  private endSegment(): void {
    if (this.speaking) {
      this.endSpeech();
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────

let cachedWasmDir: string | null = null;
let cachedModelPath: string | null = null;

function resolveWasmDir(): string {
  if (cachedWasmDir) return cachedWasmDir;

  // Resolve onnxruntime-web's dist directory where WASM files live
  const pkgPath = require.resolve('onnxruntime-web/package.json');
  cachedWasmDir = resolve(dirname(pkgPath), 'dist');

  if (!existsSync(cachedWasmDir)) {
    throw new Error(
      `onnxruntime-web WASM directory not found at ${cachedWasmDir}. ` +
        'Ensure onnxruntime-web is installed (it is a peer dependency).',
    );
  }
  return cachedWasmDir;
}

function resolveModelPath(): string {
  if (cachedModelPath) return cachedModelPath;

  // The Silero ONNX model is bundled with @ericedouard/vad-node-realtime
  const vadPkgPath = require.resolve('@ericedouard/vad-node-realtime/package.json');
  cachedModelPath = resolve(dirname(vadPkgPath), 'silero_vad_legacy.onnx');

  if (!existsSync(cachedModelPath)) {
    throw new Error(
      `Silero VAD model not found at ${cachedModelPath}. ` +
        'Ensure @ericedouard/vad-node-realtime is installed.',
    );
  }
  return cachedModelPath;
}
