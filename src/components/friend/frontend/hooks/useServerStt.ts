/**
 * Hook for server-side STT in the Friend Tauri app.
 *
 * Two modes:
 *   - push-to-talk: POST /voice/start → capture → POST /voice/stop → get text
 *   - voice-call:   POST /voice/start → server-side periodic segmentation →
 *                   POST /voice/stop → get text
 *
 * Browser VAD (@ricky0123/vad-web) is NOT used — WebKitGTK (Tauri on Linux)
 * does not support onnxruntime-web WASM. Instead, the server segments audio
 * every ~5s and sends text to the CLI conversation automatically.
 */
import { useRef, useCallback, useState } from 'react'

const FRIEND_API_BASE = 'http://127.0.0.1:3456/plugins/friend'

export type SttProvider = 'browser' | 'groq' | 'anthropic' | 'local' | 'doubao'

export function useServerStt() {
  const [connected, setConnected] = useState(false)
  const [interimText, setInterimText] = useState('')
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onTranscriptRef = useRef<((text: string, isFinal: boolean) => void) | null>(null)
  const onErrorRef = useRef<((err: string) => void) | null>(null)

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

  // ── Voice call (server-side segmentation, no browser VAD) ─────────────

  /**
   * Start voice call mode.
   *
   * Server captures microphone audio via cpal/arecord and segments it
   * every ~5 seconds, sending each segment to STT (Groq Whisper).
   * The transcript is enqueued to the CLI conversation automatically.
   */
  const startStreaming = useCallback(
    (
      _provider: SttProvider,
      onTranscript: (text: string, isFinal: boolean) => void,
      onError: (err: string) => void,
      _language = 'zh',
    ) => {
      onTranscriptRef.current = onTranscript
      onErrorRef.current = onError

      // Start server-side capture
      fetch(`${FRIEND_API_BASE}/voice/start`, { method: 'POST' })
        .then(async (res) => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Unknown error' }))
            throw new Error(err.error || 'STT start failed')
          }
          setConnected(true)

          // Poll interim status every 1s for display
          const lastTextRef = { current: '' }
          pollTimerRef.current = setInterval(async () => {
            try {
              const statusRes = await fetch(`${FRIEND_API_BASE}/voice/status`, {
                method: 'POST',
              })
              if (!statusRes.ok) return
              const status = await statusRes.json()
              const text = status.interimText || ''
              if (text && text !== lastTextRef.current) {
                lastTextRef.current = text
                setInterimText(text)
                onTranscriptRef.current?.(text, false)
              }
            } catch {
              // Polling errors are non-fatal
            }
          }, 1000)
        })
        .catch((err) => {
          console.error('[VoiceCall] start failed:', err)
          onErrorRef.current?.(String(err))
        })
    },
    [],
  )

  /** Stop voice call mode. */
  const stopStreaming = useCallback(async (): Promise<string> => {
    // Stop polling
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    setInterimText('')
    setConnected(false)

    // Stop server-side capture
    const res = await fetch(`${FRIEND_API_BASE}/voice/stop`, {
      method: 'POST',
    })
    if (!res.ok) return ''
    const data = await res.json()
    return data.text || ''
  }, [])

  return {
    connected,
    interimText,
    startPushToTalk,
    stopPushToTalk,
    startStreaming,
    stopStreaming,
  }
}
