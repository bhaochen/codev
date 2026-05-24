import { useRef, useCallback, useEffect } from 'react'
import { useCompanionStore } from '../stores/companionStore'

interface Callbacks {
  onAudioReceived: (data: ArrayBuffer) => void
  onDone?: () => void
}

export function useCompanionWebSocket(callbacks: Callbacks) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const callbacksRef = useRef(callbacks)
  const manualDisconnectRef = useRef(false)
  const serverUrl = useCompanionStore((s) => s.serverUrl)
  const status = useCompanionStore((s) => s.status)
  const setStatus = useCompanionStore((s) => s.setStatus)
  const setSpeaking = useCompanionStore((s) => s.setSpeaking)
  const setGenerating = useCompanionStore((s) => s.setGenerating)
  const appendTranscript = useCompanionStore((s) => s.appendTranscript)
  const appendFullTranscript = useCompanionStore((s) => s.appendFullTranscript)
  const resetTranscript = useCompanionStore((s) => s.resetTranscript)
  const setError = useCompanionStore((s) => s.setError)

  // Keep callbacks ref current
  callbacksRef.current = callbacks

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.onopen = null
      wsRef.current.onclose = null
      wsRef.current.onmessage = null
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  const connect = useCallback(() => {
    manualDisconnectRef.current = false
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return
    }

    cleanup()
    setStatus('connecting')
    setError(null)
    resetTranscript()
    reconnectAttemptRef.current = 0

    const ws = new WebSocket(serverUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      reconnectAttemptRef.current = 0
      setStatus('connected')
    }

    ws.onclose = () => {
      if (!manualDisconnectRef.current) {
        // Auto reconnect with exponential backoff
        const attempt = reconnectAttemptRef.current
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
        reconnectAttemptRef.current = attempt + 1
        reconnectTimerRef.current = setTimeout(() => {
          connect()
        }, delay)
      }
      setStatus('disconnected')
    }

    ws.onerror = () => {
      setError('WebSocket connection error')
    }

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary frame = PCM audio
        callbacksRef.current.onAudioReceived(event.data)
      } else {
        // Text frame = JSON control message
        try {
          const msg = JSON.parse(event.data)
          switch (msg.type) {
            case 'vad':
              setSpeaking(msg.speaking)
              break
            case 'generating':
              setGenerating(true)
              resetTranscript()
              break
            case 'text':
              appendTranscript(msg.content)
              break
            case 'done':
              appendFullTranscript(
                useCompanionStore.getState().transcript
              )
              setGenerating(false)
              setSpeaking(false)
              callbacksRef.current.onDone?.()
              break
          }
        } catch {
          // Ignore malformed messages
        }
      }
    }
  }, [serverUrl, cleanup, setStatus, setError, resetTranscript, setSpeaking, setGenerating, appendTranscript, appendFullTranscript])

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true
    cleanup()
    setStatus('disconnected')
    setError(null)
  }, [cleanup, setStatus])

  const sendFrame = useCallback((base64Jpeg: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'frame', data: base64Jpeg }))
    }
  }, [])

  const sendAudio = useCallback((buffer: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(buffer)
    }
  }, [])

  const sendStop = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }))
    }
  }, [])

  const sendText = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'text', content: text }))
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      manualDisconnectRef.current = true
      cleanup()
    }
  }, [cleanup])

  return {
    connect,
    disconnect,
    sendFrame,
    sendAudio,
    sendStop,
    sendText,
    connected: status === 'connected',
  }
}
