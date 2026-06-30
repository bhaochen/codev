import { useState, useRef, useCallback, useEffect } from 'react'
import { Phone, PhoneOff, Mic } from 'lucide-react'
import { FRIEND_API } from '../api'
import { useServerStt, type SttProvider } from '../hooks/useServerStt'

export function ChatInput({ uiAlign = 'right', language = 'zh', sttProvider = 'browser' }: { uiAlign?: 'left' | 'right'; language?: 'zh' | 'en'; sttProvider?: SttProvider }) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const [voiceCallActive, setVoiceCallActive] = useState(false)
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const voiceCallActiveRef = useRef(false)
  const serverStt = useServerStt()
  const displayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- Voice Call ---
  const startVoiceCall = useCallback(async () => {
    setVoiceCallActive(true)
    voiceCallActiveRef.current = true
    setText('')

    serverStt.startStreaming(
      sttProvider,
      (partialText, _isFinal) => {
        if (partialText.trim()) {
          setText(partialText)
          if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
          displayTimerRef.current = setTimeout(() => {
            if (voiceCallActiveRef.current) {
              setText('')
            }
          }, 3000)
        }
      },
      (err) => {
        console.error('Voice call error:', err)
        if (voiceCallActiveRef.current) {
          setText(`\u8bed\u97f3\u542f\u52a8\u5931\u8d25: ${err}`)
          setTimeout(() => {
            setText('')
            endVoiceCall()
          }, 3000)
        }
      },
      language === 'en' ? 'en' : 'zh',
    )
    setRecording(true)
  }, [sttProvider, serverStt, language])

  const endVoiceCall = useCallback(async () => {
    if (!voiceCallActiveRef.current) return
    voiceCallActiveRef.current = false
    setVoiceCallActive(false)
    setRecording(false)
    const finalText = await serverStt.stopStreaming()
    if (finalText.trim()) {
      // Send text via chat endpoint
      fetch(`${FRIEND_API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: finalText }),
      }).catch(() => {})
    }
    setText('')
  }, [serverStt])

  // Global keyboard shortcuts
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === 'F2') {
        e.preventDefault()
        if (voiceCallActive) {
          endVoiceCall()
        } else {
          startVoiceCall()
        }
      }
    }
    window.addEventListener('keydown', onGlobalKeyDown)
    return () => window.removeEventListener('keydown', onGlobalKeyDown)
  }, [voiceCallActive, startVoiceCall, endVoiceCall])

  // Broadcast recording state for VRM "listening" response
  useEffect(() => {
    (window as any).__userRecording = recording
    return () => { (window as any).__userRecording = false }
  }, [recording])

  // Cleanup display timer
  useEffect(() => {
    return () => {
      if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
    }
  }, [])

  if (voiceCallActive) {
    return (
      <div style={barStyle}>
        <div style={{ flex: 1, position: 'relative' }}>
          <div
            style={{
              ...inputStyle,
              paddingLeft: 48,
              paddingRight: 80,
              display: 'flex',
              alignItems: 'center',
              borderColor: recording ? 'rgba(255, 80, 80, 0.7)' : 'rgba(255, 80, 80, 0.25)',
            }}
            data-no-passthrough
          >
            <span style={{ color: text ? '#fff' : 'rgba(255, 255, 255, 0.45)', fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' }}>
              {text || (recording ? t('正在听...', 'Listening...') : t('等待说话...', 'Waiting to speak...'))}
            </span>
          </div>
          <span
            style={{
              position: 'absolute',
              top: '50%',
              transform: 'translateY(-50%)',
              right: 44,
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: recording ? 'rgba(255, 80, 80, 0.9)' : 'rgba(80, 200, 120, 0.9)',
              animation: recording ? 'claw-pulse 0.8s ease-in-out infinite' : 'none',
              transition: 'color 0.2s',
              cursor: 'default',
            }}
          >
            <Mic size={22} />
          </span>
          <button
            onClick={endVoiceCall}
            style={{
              position: 'absolute',
              top: '50%',
              transform: 'translateY(-50%)',
              right: 12,
              width: 32,
              height: 32,
              border: 'none',
              borderRadius: 4,
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              color: 'rgba(255, 80, 80, 0.9)',
            }}
            title={t('挂断 (F2)', 'Hang up (F2)')}
          >
            <PhoneOff size={22} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', bottom: 8, ...(uiAlign === 'left' ? { left: 12 } : { right: 12 }), zIndex: 300, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
      <button
        onClick={startVoiceCall}
        style={{
          width: 32,
          height: 32,
          border: 'none',
          borderRadius: 6,
          background: 'rgba(125, 125, 125, 0.28)',
          backdropFilter: 'blur(6px)',
          color: 'rgba(255, 255, 255, 0.8)',
          fontSize: 16,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 300,
          pointerEvents: 'auto',
        }}
        title={t('语音通话 (F2)', 'Voice Call (F2)')}
      >
        <Phone size={16} />
      </button>
    </div>
  )
}

const barStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  left: 12,
  right: 12,
  display: 'flex',
  gap: 4,
  zIndex: 300,
  pointerEvents: 'auto',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 50,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 25,
  background: 'rgba(0, 0, 0, 0.4)',
  backdropFilter: 'blur(6px)',
  color: '#fff',
  fontSize: 18,
  padding: '0 10px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}
