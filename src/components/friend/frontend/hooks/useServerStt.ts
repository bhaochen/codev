/**
 * Hook for using browser-based energy VAD + server-side STT
 * in the Friend Tauri app.
 *
 * Audio capture and VAD run in the browser via Web Audio API.
 * Uses simple energy (RMS) detection for voice activity —
 * no WASM or external dependencies needed.
 *
 * Two modes:
 *   - push-to-talk: POST /voice/start → capture → POST /voice/stop → get text
 *   - voice-call:   Browser energy VAD detects speech segments → sends to server for STT
 */
import { useRef, useCallback, useState } from 'react'

const FRIEND_API_BASE = 'http://127.0.0.1:3456/plugins/friend'

export type SttProvider = 'browser' | 'groq' | 'anthropic' | 'local' | 'doubao'

/**
 * Convert Float32Array audio (between -1 and 1, 16kHz) to a WAV Blob.
 */
function float32ToWav(samples: Float32Array, sampleRate = 16000): Blob {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = samples.length * (bitsPerSample / 8)
  const headerSize = 44
  const totalSize = headerSize + dataSize

  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, totalSize - 8, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // Write PCM samples
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

/** Compute RMS (root mean square) energy of a float32 audio frame */
function computeRms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i]
  }
  return Math.sqrt(sum / samples.length)
}

/**
 * Simple energy-based Voice Activity Detector.
 * Uses RMS threshold with configurable hangover time.
 */
class EnergyVad {
  private threshold: number
  private hangoverFrames: number
  private speaking = false
  private silentFrames = 0
  private speechFrames: Float32Array[] = []
  private speechStartRms = 0

  constructor(threshold = 0.008, hangoverMs = 800, frameMs = 30) {
    this.threshold = threshold
    this.hangoverFrames = Math.ceil(hangoverMs / frameMs)
  }

  /** Process a single audio frame. Returns true if speech just ended (with accumulated audio). */
  process(frame: Float32Array, rms?: number): { speechEnded: boolean; audio: Float32Array | null } {
    const energy = rms ?? computeRms(frame)

    if (energy > this.threshold && !this.speaking) {
      // Speech just started
      this.speaking = true
      this.silentFrames = 0
      this.speechFrames = [frame]
      this.speechStartRms = energy
      return { speechEnded: false, audio: null }
    }

    if (this.speaking) {
      this.speechFrames.push(frame)

      if (energy < this.threshold) {
        this.silentFrames++
        if (this.silentFrames >= this.hangoverFrames) {
          // Speech ended after hangover
          const audio = this.flush()
          return { speechEnded: true, audio }
        }
      } else {
        this.silentFrames = 0
      }
    }

    return { speechEnded: false, audio: null }
  }

  /** Flush accumulated audio and reset state */
  private flush(): Float32Array | null {
    if (this.speechFrames.length < 3) {
      this.speechFrames = []
      this.speaking = false
      return null
    }
    const totalLen = this.speechFrames.reduce((s, f) => s + f.length, 0)
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const f of this.speechFrames) {
      merged.set(f, offset)
      offset += f.length
    }
    this.speechFrames = []
    this.speaking = false
    return merged
  }

  reset(): void {
    this.speaking = false
    this.silentFrames = 0
    this.speechFrames = []
  }

  isSpeaking(): boolean {
    return this.speaking
  }
}

export function useServerStt() {
  const [connected, setConnected] = useState(false)
  const onTranscriptRef = useRef<((text: string, isFinal: boolean) => void) | null>(null)
  const onErrorRef = useRef<((err: string) => void) | null>(null)
  const vadRef = useRef<EnergyVad | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null)

  // ── Push-to-talk ──────────────────────────────────────────────────────

  /** Start push-to-talk: tell backend to start audio capture. */
  const startPushToTalk = useCallback(
    async (_provider: SttProvider, _language: string): Promise<void> => {
      const res = await fetch(`${FRIEND_API_BASE}/voice/start`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(err.error || 'STT start failed')
      }
      setConnected(true)
    },
    [],
  )

  /** Stop push-to-talk: stop capture and return transcript text. */
  const stopPushToTalk = useCallback(async (): Promise<string> => {
    const res = await fetch(`${FRIEND_API_BASE}/voice/stop`, {
      method: 'POST',
    })
    setConnected(false)
    if (!res.ok) return ''
    const data = await res.json()
    return data.text || ''
  }, [])

  // ── Voice call with browser energy VAD ────────────────────────────────

  /**
   * Start voice call mode with browser-based energy VAD.
   *
   * Uses Web Audio API (ScriptProcessorNode) to detect speech segments
   * via RMS threshold. No WASM or external dependencies.
   *
   * When a speech segment ends, the audio is sent to the server for STT
   * transcription (same /voice/stt-segment endpoint).
   */
  const startStreaming = useCallback(
    (
      _provider: SttProvider,
      onTranscript: (text: string, isFinal: boolean) => void,
      onError: (err: string) => void,
      _language = 'zh',
    ) => {
      // Clean up any existing session
      stopCapture()

      onTranscriptRef.current = onTranscript
      onErrorRef.current = onError

      const startCapture = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              autoGainControl: true,
              noiseSuppression: true,
              sampleRate: 16000,
            },
          })
          streamRef.current = stream

          const audioCtx = new AudioContext({ sampleRate: 16000 })
          audioContextRef.current = audioCtx

          const source = audioCtx.createMediaStreamSource(stream)
          sourceNodeRef.current = source

          const scriptNode = audioCtx.createScriptProcessor(1024, 1, 1)
          scriptNodeRef.current = scriptNode

          const vad = new EnergyVad(0.006, 800, 64)
          vadRef.current = vad

          scriptNode.onaudioprocess = (e) => {
            if (!vadRef.current) return

            const input = e.inputBuffer.getChannelData(0)
            const rms = computeRms(input)
            const result = vadRef.current.process(input, rms)

            if (result.speechEnded && result.audio && result.audio.length > 0) {
              // Send to server for STT
              const wavBlob = float32ToWav(result.audio)

              fetch(`${FRIEND_API_BASE}/voice/stt-segment`, {
                method: 'POST',
                body: wavBlob,
                headers: { 'Content-Type': 'application/octet-stream' },
              })
                .then(async (res) => {
                  if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}))
                    throw new Error(errBody.error || `STT failed (${res.status})`)
                  }
                  const data = await res.json()
                  if (data.text && data.text.trim()) {
                    onTranscriptRef.current?.(data.text, true)
                  }
                })
                .catch((err) => {
                  console.error('[EnergyVAD] STT segment error:', err)
                  onErrorRef.current?.(err.message)
                })
            }
          }

          // Ensure output is connected (needed for Chrome/Chromium)
          scriptNode.connect(audioCtx.destination)
          source.connect(scriptNode)

          setConnected(true)
          console.log('[EnergyVAD] Started')
        } catch (err: any) {
          console.error('[EnergyVAD] Init failed:', err)
          onErrorRef.current?.(String(err))
        }
      }

      startCapture()
    },
    [],
  )

  function stopCapture(): void {
    if (scriptNodeRef.current) {
      try { scriptNodeRef.current.disconnect() } catch {}
      scriptNodeRef.current = null
    }
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.disconnect() } catch {}
      sourceNodeRef.current = null
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close() } catch {}
      audioContextRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    vadRef.current = null
  }

  /**
   * Stop voice call mode.
   * Cleans up all audio resources.
   */
  const stopStreaming = useCallback(async (): Promise<string> => {
    stopCapture()
    setConnected(false)
    return ''
  }, [])

  return {
    connected,
    startPushToTalk,
    stopPushToTalk,
    startStreaming,
    stopStreaming,
  }
}
