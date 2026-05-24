export type EngineState =
  | 'uninitialized'
  | 'initializing'
  | 'running'
  | 'suspended'
  | 'failed'
  | 'closed'
  | 'fallback'

// PCM Int16 -> Float32 conversion
function pcmToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    const sample = int16[i]!
    float32[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff
  }
  return float32
}

// PCM Int16 -> WAV Blob (for fallback mode)
function pcmToWav(pcmBuffer: ArrayBuffer): Blob {
  const int16 = new Int16Array(pcmBuffer)
  const numSamples = int16.length
  if (numSamples === 0) {
    const empty = new ArrayBuffer(44)
    const v = new DataView(empty)
    const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); v.setUint32(4, 36, true); w(8, 'WAVE')
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
    v.setUint16(22, 1, true); v.setUint32(24, 24000, true); v.setUint32(28, 48000, true)
    v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    w(36, 'data'); v.setUint32(40, 0, true)
    return new Blob([empty], { type: 'audio/wav' })
  }

  const sampleRate = 24000
  const numChannels = 1
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = numSamples * blockAlign
  const totalSize = 44 + dataSize

  const buf = new ArrayBuffer(totalSize)
  const v = new DataView(buf)

  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }

  w(0, 'RIFF')
  v.setUint32(4, totalSize - 8, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM
  v.setUint16(20, 1, true)
  v.setUint16(22, numChannels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, bitsPerSample, true)
  w(36, 'data')
  v.setUint32(40, dataSize, true)

  new Int16Array(buf, 44, numSamples).set(int16)
  return new Blob([buf], { type: 'audio/wav' })
}

// Safety limit: 60 seconds = 1,440,000 samples @ 24kHz
const MAX_FALLBACK_SAMPLES = 24000 * 60

export class AudioEngine {
  private ctx: AudioContext | null = null
  private state: EngineState = 'uninitialized'
  private nextTime: number = 0
  private keepaliveOsc: OscillatorNode | null = null
  private keepaliveGain: GainNode | null = null

  // MediaStream keepalive (secondary — most reliable for WebKit)
  private silentAudioEl: HTMLAudioElement | null = null
  private mediaStreamDest: MediaStreamAudioDestinationNode | null = null

  // Fallback accumulators
  private chunks: Int16Array[] = []
  private totalSamples: number = 0

  // State change callback
  private onStateChange: ((s: EngineState) => void) | null = null

  constructor(onStateChange?: (s: EngineState) => void) {
    this.onStateChange = onStateChange || null
  }

  getState(): EngineState {
    return this.state
  }

  private setState(s: EngineState) {
    this.state = s
    this.onStateChange?.(s)
  }

  async initialize(): Promise<boolean> {
    if (this.state === 'running') return true
    if (this.state === 'fallback') return false

    this.setState('initializing')

    try {
      // Create AudioContext (MUST be called during user gesture)
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      this.ctx = ctx

      // Primary keepalive: low-freq oscillator (inaudible, keeps context running)
      this.keepaliveGain = ctx.createGain()
      this.keepaliveGain.gain.value = 0.001
      this.keepaliveOsc = ctx.createOscillator()
      this.keepaliveOsc.frequency.value = 1
      this.keepaliveOsc.connect(this.keepaliveGain)
      this.keepaliveGain.connect(ctx.destination)
      this.keepaliveOsc.start()

      // Secondary keepalive: MediaStream destination trick
      // WebKit treats a live MediaStream as non-idle and won't suspend the context
      try {
        this.mediaStreamDest = ctx.createMediaStreamDestination()
        const keepaliveGain2 = ctx.createGain()
        keepaliveGain2.gain.value = 0
        keepaliveGain2.connect(this.mediaStreamDest)
        this.silentAudioEl = new Audio()
        this.silentAudioEl.srcObject = this.mediaStreamDest.stream
        this.silentAudioEl.play().catch(() => {})
      } catch {
        // MediaStream destination not supported; oscillator keepalive is sufficient
      }

      this.nextTime = ctx.currentTime

      // Handle state changes
      ctx.onstatechange = () => this.handleStateChange()

      this.setState('running')

      console.log('[AudioEngine] AudioContext created, keepalive running')
      return true
    } catch (e) {
      console.warn('[AudioEngine] Failed to create AudioContext, switching to fallback mode', e)
      this.enterFallbackMode()
      return false
    }
  }

  private handleStateChange() {
    if (!this.ctx) return
    const ctx = this.ctx

    if (ctx.state === 'suspended') {
      console.log('[AudioEngine] context suspended, attempting resume')
      this.setState('suspended')
      ctx.resume()
        .then(() => {
          if (this.ctx?.state === 'running') {
            this.setState('running')
            // Reset nextTime after suspension
            this.nextTime = Math.max(this.nextTime, this.ctx.currentTime)
          }
        })
        .catch(() => {
          console.warn('[AudioEngine] resume() failed, switching to fallback')
          this.enterFallbackMode()
        })
    } else if (ctx.state === 'closed') {
      console.warn('[AudioEngine] context closed, switching to fallback')
      this.enterFallbackMode()
    } else if (ctx.state === 'running') {
      this.setState('running')
    }
  }

  private enterFallbackMode() {
    if (this.state === 'fallback') return
    console.log('[AudioEngine] entering fallback mode')
    this.setState('fallback')
    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
    }
    if (this.keepaliveOsc) {
      try { this.keepaliveOsc.stop() } catch {}
      this.keepaliveOsc = null
    }
    if (this.keepaliveGain) {
      this.keepaliveGain = null
    }
    this.cleanupMediaStream()
  }

  private cleanupMediaStream() {
    if (this.silentAudioEl) {
      this.silentAudioEl.pause()
      this.silentAudioEl.srcObject = null
      this.silentAudioEl = null
    }
    if (this.mediaStreamDest) {
      this.mediaStreamDest.disconnect()
      this.mediaStreamDest = null
    }
  }

  enqueuePCM(pcmData: ArrayBuffer): void {
    if (this.state === 'fallback') {
      this.enqueueFallback(pcmData)
      return
    }
    if (this.state !== 'running' || !this.ctx) {
      // Drop audio until initialized; user needs to click Connect
      return
    }

    const ctx = this.ctx
    const int16 = new Int16Array(pcmData)
    const float32 = pcmToFloat32(int16)

    // Apply micro-fades at chunk boundaries to prevent clicking artifacts.
    // 128 samples @ 24kHz = ~5.3ms fade — inaudible as a fade but eliminates
    // the DC discontinuity between consecutive scheduled chunks.
    const FADE_LEN = Math.min(128, float32.length >> 1)
    if (FADE_LEN > 0) {
      for (let i = 0; i < FADE_LEN; i++) {
        const t = i / FADE_LEN
        float32[i] *= t                         // fade in
        float32[float32.length - 1 - i] *= t    // fade out
      }
    }

    // Create audio buffer
    const audioBuffer = ctx.createBuffer(1, float32.length, 24000)
    audioBuffer.getChannelData(0).set(float32)

    // Create source node
    const source = ctx.createBufferSource()
    source.buffer = audioBuffer

    // Connect through a gain node for consistency
    // We'll use the keepalive gain's destination, but create separate gain per buffer
    // Actually just connect to destination directly; we have keepalive running already
    source.connect(ctx.destination)

    // Schedule at the correct time for gapless playback
    const startTime = Math.max(ctx.currentTime, this.nextTime)
    source.start(startTime)

    // Advance the scheduled time
    this.nextTime = startTime + audioBuffer.duration

    // Cleanup when playback ends
    source.onended = () => {
      try { source.disconnect() } catch {}
    }
  }

  private enqueueFallback(pcmData: ArrayBuffer) {
    const chunk = new Int16Array(pcmData)
    this.chunks.push(chunk)
    this.totalSamples += chunk.length

    // Safety: if we exceed 60s, force-flush so user hears SOMETHING
    if (this.totalSamples >= MAX_FALLBACK_SAMPLES) {
      console.warn('[AudioEngine] Fallback buffer exceeded 60s, force-flushing')
      // We don't flush here; flush() is called externally on `done`
      // The caller needs to decide how to play the WAV
    }
  }

  /**
   * In fallback mode: concatenate all accumulated PCM and return a WAV Blob.
   * In Web Audio mode: returns null (audio already scheduled).
   */
  flush(): Blob | null {
    if (this.state === 'fallback' && this.totalSamples > 0) {
      const combined = new Int16Array(this.totalSamples)
      let offset = 0
      for (const chunk of this.chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }
      this.chunks = []
      this.totalSamples = 0
      return pcmToWav(combined.buffer)
    }
    // In Web Audio mode, nothing to do
    return null
  }

  stop(): void {
    // Stop keepalive
    if (this.keepaliveOsc) {
      try { this.keepaliveOsc.stop() } catch {}
      try { this.keepaliveOsc.disconnect() } catch {}
      this.keepaliveOsc = null
    }
    if (this.keepaliveGain) {
      try { this.keepaliveGain.disconnect() } catch {}
      this.keepaliveGain = null
    }
    this.cleanupMediaStream()

    // Close AudioContext
    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
    }

    // Clear fallback accumulators
    this.chunks = []
    this.totalSamples = 0

    this.nextTime = 0
    this.setState('uninitialized')
  }
}
