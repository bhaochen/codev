/**
 * Hook for using server-side STT (Groq Whisper, Anthropic Voice Stream, Local Whisper, Doubao)
 * in the Friend Tauri app.
 *
 * Audio capture is done server-side via cpal (in-process native addon)
 * so no getUserMedia call is needed on the frontend — this avoids
 * WebKitGTK permission issues on Linux.
 *
 * Two modes:
 *   - push-to-talk: POST /voice/start → capture → POST /voice/stop → get text
 *   - streaming:    POST /voice/start → poll /voice/status + auto-cycle every 3s
 *
 * The auto-cycle in streaming mode ensures batch STT providers (Groq, local Whisper)
 * produce regular final transcripts even though they don't support interim results.
 */
import { useRef, useCallback, useState } from 'react'

const FRIEND_API_BASE = 'http://127.0.0.1:3456/plugins/friend'

export type SttProvider = 'browser' | 'groq' | 'anthropic' | 'local' | 'doubao'

export function useServerStt() {
  const [connected, setConnected] = useState(false)
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cycleAccumRef = useRef('')
  const streamingGenRef = useRef(0) // generation counter to prevent stale callbacks

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

  // ── Streaming (voice call) with auto-cycle ────────────────────────────

  const doCycle = useCallback(
    (onTranscript: (text: string, isFinal: boolean) => void, gen: number): void => {
      const isStale = () => streamingGenRef.current !== gen
      fetch(`${FRIEND_API_BASE}/voice/stop`, { method: 'POST' })
        .then(async (res) => {
          if (isStale()) return
          if (!res.ok) return
          const data = await res.json()
          if (data.text?.trim()) {
            cycleAccumRef.current += data.text
            onTranscript(cycleAccumRef.current, true)
          }
        })
        .then(() => {
          if (isStale()) return
          // Restart capture for next cycle
          return fetch(`${FRIEND_API_BASE}/voice/start`, { method: 'POST' })
        })
        .then(async (res) => {
          if (isStale()) return
          if (!res?.ok) {
            setConnected(false)
            return
          }
          setConnected(true)
          // Schedule next cycle in 3s
          cycleTimerRef.current = setTimeout(
            () => doCycle(onTranscript, gen),
            3000,
          )
        })
        .catch(() => {})
    },
    [],
  )

  /**
   * Start streaming STT for voice call mode.
   * Polls interim results every 500ms AND auto-cycles every 3s to get
   * final transcripts from batch STT providers (Groq, local Whisper).
   */
  const startStreaming = useCallback(
    (
      _provider: SttProvider,
      onTranscript: (text: string, isFinal: boolean) => void,
      onError: (err: string) => void,
      _language = 'zh',
    ) => {
      // Clean up any existing state and bump generation
      cycleAccumRef.current = ''
      const myGen = ++streamingGenRef.current
      const existingPollId = (window as any).__friendSttPollId
      if (existingPollId) { clearInterval(existingPollId); delete (window as any).__friendSttPollId }
      if (cycleTimerRef.current) { clearTimeout(cycleTimerRef.current); cycleTimerRef.current = null }

      fetch(`${FRIEND_API_BASE}/voice/start`, { method: 'POST' })
        .then(async (res) => {
          if (streamingGenRef.current !== myGen) return
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || 'STT start failed')
          }
          setConnected(true)

          // Poll for interim results every 500ms (works with streaming STT providers)
          const pollId = setInterval(async () => {
            try {
              if (streamingGenRef.current !== myGen) { clearInterval(pollId); return }
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
          ;(window as any).__friendSttPollId = pollId

          // Schedule first auto-cycle in 3s (for batch STT providers like Groq)
          cycleTimerRef.current = setTimeout(
            () => doCycle(onTranscript, myGen),
            3000,
          )
        })
        .catch((err) => {
          if (streamingGenRef.current === myGen) {
            onError(err.message)
          }
        })
    },
    [doCycle],
  )

  /**
   * Stop streaming STT.
   * Cleans up poll interval and auto-cycle, then returns the final transcript.
   */
  const stopStreaming = useCallback(async (): Promise<string> => {
    // Stop all activity by bumping generation counter
    streamingGenRef.current++
    const pollId = (window as any).__friendSttPollId
    if (pollId) {
      clearInterval(pollId)
      delete (window as any).__friendSttPollId
    }

    // Stop auto-cycle
    if (cycleTimerRef.current) {
      clearTimeout(cycleTimerRef.current)
      cycleTimerRef.current = null
    }
    cycleAccumRef.current = ''

    const res = await fetch(`${FRIEND_API_BASE}/voice/stop`, { method: 'POST' })
    setConnected(false)
    if (!res.ok) return ''
    const data = await res.json()
    return data.text || ''
  }, [])

  return {
    connected,
    startPushToTalk,
    stopPushToTalk,
    startStreaming,
    stopStreaming,
  }
}
