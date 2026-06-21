/**
 * Hook for using server-side STT (Anthropic Voice Stream, Local Whisper, Doubao)
 * in the Friend Tauri app.
 *
 * Audio capture is done server-side via cpal (in-process native addon)
 * so no getUserMedia call is needed on the frontend — this avoids
 * WebKitGTK permission issues on Linux.
 *
 * Two modes:
 *   - push-to-talk: POST /voice/start → capture → POST /voice/stop → get text
 *   - streaming:    POST /voice/start → poll /voice/status → POST /voice/stop
 */
import { useRef, useCallback, useState } from 'react'

const FRIEND_API_BASE = 'http://127.0.0.1:3456/plugins/friend'

export type SttProvider = 'browser' | 'anthropic' | 'local' | 'doubao'

export function useServerStt() {
  const [connected, setConnected] = useState(false)

  // ── Push-to-talk ──────────────────────────────────────────────────────

  /** Start push-to-talk: tell backend to start audio capture via cpal. */
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

  // ── Streaming (voice call) ────────────────────────────────────────────

  /**
   * Start streaming STT for voice call mode.
   * Transcripts arrive via polling /voice/status.
   */
  const startStreaming = useCallback(
    (
      _provider: SttProvider,
      onTranscript: (text: string, isFinal: boolean) => void,
      onError: (err: string) => void,
      _language = 'zh',
    ) => {
      // Start capture
      fetch(`${FRIEND_API_BASE}/voice/start`, { method: 'POST' })
        .then((res) => {
          if (!res.ok) throw new Error('STT start failed')
          setConnected(true)

          // Poll for interim results every 500ms
          const pollId = setInterval(async () => {
            try {
              const statusRes = await fetch(`${FRIEND_API_BASE}/voice/status`, {
                method: 'POST',
              })
              if (!statusRes.ok) return
              const status = await statusRes.json()
              if (status.interimText) {
                onTranscript(status.interimText, false)
              }
            } catch {
              // poll failed, ignore
            }
          }, 500)

          // Store poll ID for cleanup
          ;(window as any).__friendSttPollId = pollId
        })
        .catch((err) => {
          onError(err.message)
        })
    },
    [],
  )

  /** Stop streaming STT. */
  const stopStreaming = useCallback(() => {
    // Stop polling
    const pollId = (window as any).__friendSttPollId
    if (pollId) {
      clearInterval(pollId)
      delete (window as any).__friendSttPollId
    }

    // Stop capture
    fetch(`${FRIEND_API_BASE}/voice/stop`, { method: 'POST' })
      .catch(() => {})
      .finally(() => {
        setConnected(false)
      })
  }, [])

  return {
    connected,
    startPushToTalk,
    stopPushToTalk,
    startStreaming,
    stopStreaming,
  }
}
