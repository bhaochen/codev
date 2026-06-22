import { useState, useRef, useCallback, useEffect } from 'react'
import { MessageCircle, Send, Loader, Mic, ChevronDown, History, SquarePen, Plus, Phone, PhoneOff } from 'lucide-react'
import { FRIEND_API } from '../api'
import { useServerStt, type SttProvider } from '../hooks/useServerStt'

// Keyframes (claw-input-slide-up, claw-input-slide-down, claw-pulse) are in index.html <style>

export function ChatInput({ visible = true, onActiveChange, uiAlign = 'right', onHistoryOpen, onNewSession, language = 'zh', sttProvider = 'browser' }: { visible?: boolean; onActiveChange?: (hasText: boolean) => void; uiAlign?: 'left' | 'right'; onHistoryOpen?: () => void; onNewSession?: () => void; language?: 'zh' | 'en'; sttProvider?: SttProvider }) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [closing, setClosing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [voiceCallActive, setVoiceCallActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const voiceCallActiveRef = useRef(false)
  const endVoiceCallRef = useRef<() => void>(() => {})
  const serverStt = useServerStt()

  const closeBar = useCallback(() => {
    if (closing) return
    setMenuOpen(false)
    setClosing(true)
    setTimeout(() => { setOpen(false); setClosing(false) }, 220)
  }, [closing])

  const send = useCallback(async (msg?: string) => {
    const finalMsg = (msg ?? text).trim()
    if (!finalMsg || sending) return
    setSending(true)
    setText('')
    onActiveChange?.(false)
    try {
      await fetch(`${FRIEND_API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: finalMsg }),
      })
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }, [text, sending])

  const startRecording = useCallback(async () => {
    // All voice capture is server-side via cpal (no getUserMedia needed)
    try {
      await serverStt.startPushToTalk(sttProvider, language === 'en' ? 'en' : 'zh')
      setRecording(true)
      setOpen(true)
    } catch (err) {
      console.error('Server STT start error:', err)
      setRecording(false)
    }
  }, [sttProvider, serverStt, language])

  const stopRecording = useCallback(async () => {
    if (sttProvider === 'browser') {
      // Browser STT may not be available, just stop
      setRecording(false)
      return
    }
    setRecording(false)
    try {
      const text = await serverStt.stopPushToTalk()
      setText(text)
      onActiveChange?.(text.length > 0)
    } catch (err) {
      console.error('Server STT stop error:', err)
    }
  }, [serverStt, sttProvider, onActiveChange])

  const handleMouseLeave = useCallback(() => {
    if (recording) stopRecording()
  }, [recording, stopRecording])

  // --- Voice Call: delayed TTS interrupt ---
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleInterrupt = useCallback(() => {
    if (interruptTimerRef.current) return
    interruptTimerRef.current = setTimeout(() => {
      interruptTimerRef.current = null
      ;(window as any).__clawInterruptAudio?.()
    }, 1000)
  }, [])
  const cancelInterrupt = useCallback(() => {
    if (interruptTimerRef.current) { clearTimeout(interruptTimerRef.current); interruptTimerRef.current = null }
  }, [])

  // Voice call display timer — clear text after 3s
  const displayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- Voice Call: start (browser VAD with @ricky0123/vad-web) ---
  const startVoiceCall = useCallback(async () => {
    setVoiceCallActive(true)
    voiceCallActiveRef.current = true
    setText('')
    setOpen(true)

    serverStt.startStreaming(
      sttProvider,
      (text, _isFinal) => {
        // Server-side transcribeAudioSegment() already calls sendText()
        // to enqueue the message into the CLI conversation.
        // We only need to display the transcript in the input bar briefly.
        if (text.trim()) {
          setText(text)
          onActiveChange?.(true)
          // Auto-clear after 3s
          if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
          displayTimerRef.current = setTimeout(() => {
            if (voiceCallActiveRef.current) {
              setText('')
              onActiveChange?.(false)
            }
          }, 3000)
        }
      },
      (err) => {
        console.error('Browser VAD error:', err)
        if (voiceCallActiveRef.current) {
          setText(`语音启动失败: ${err}`)
          setTimeout(() => {
            setText('')
            endVoiceCallRef.current()
          }, 3000)
        }
      },
      language === 'en' ? 'en' : 'zh',
    )
    setRecording(true)
  }, [sttProvider, serverStt, language, onActiveChange])

  // --- Voice Call: end ---
  const endVoiceCall = useCallback(async () => {
    if (!voiceCallActiveRef.current) return // guard against double-invocation
    voiceCallActiveRef.current = false
    setVoiceCallActive(false)
    setRecording(false)

    // Stop VAD and clean up
    const finalText = await serverStt.stopStreaming()

    // Send any remaining transcript (no-op if empty — segments were already
    // sent to CLI by transcribeAudioSegment() during the call).
    if (finalText.trim()) {
      send(finalText)
    }

    cancelInterrupt()

    setText('')
    setOpen(false)
    onActiveChange?.(false)
  }, [onActiveChange, cancelInterrupt, serverStt, send])

  endVoiceCallRef.current = endVoiceCall

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
    if (e.key === 'Escape') {
      closeBar()
    }
    if ((e.key === 'Delete') || (e.key === 'd' && e.ctrlKey)) {
      e.preventDefault()
      setText('')
      onActiveChange?.(false)
    }
  }

  // Global keyboard shortcuts
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (!visible) return
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

      if (e.key === 'Enter' && !e.shiftKey && !inInput) {
        e.preventDefault()
        if (!open) {
          setMenuOpen(false)
          setOpen(true)
        }
        setTimeout(() => inputRef.current?.focus(), 50)
      }

      if (e.key === 'Escape' && open && !inInput) {
        e.preventDefault()
        closeBar()
      }

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
  }, [open, visible, voiceCallActive, closeBar, startVoiceCall, endVoiceCall])

  if (!visible) return null

  if (!open) {
    return (
      <div style={{ position: 'absolute', bottom: 8, ...(uiAlign === 'left' ? { left: 12 } : { right: 12 }), zIndex: 300, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
        <button
          onClick={startVoiceCall}
          style={fabStyle}
          title={t('语音通话 (F2)', 'Voice Call (F2)')}
        >
          <Phone size={16} />
        </button>
        <button
          onClick={() => {
            setMenuOpen(false)
            setOpen(true)
            setTimeout(() => inputRef.current?.focus(), 50)
          }}
          style={fabStyle}
          title={t('发送消息 (Enter)', 'Send Message (Enter)')}
        >
          <MessageCircle size={16} />
        </button>
      </div>
    )
  }

  if (voiceCallActive) {
    return (
      <div style={barStyle}>
        <div style={{ flex: 1, position: 'relative' }}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            style={{ ...inlineBtnLeft, color: menuOpen ? 'rgba(100, 160, 255, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
            title={t('更多', 'More')}
          >
            <Plus size={22} />
          </button>
          {menuOpen && (
            <div style={popupMenuStyle}>
              <button onClick={() => { setMenuOpen(false); onHistoryOpen?.() }} style={popupItemStyle}>
                <History size={14} />
                <span>{t('对话历史', 'History')}</span>
              </button>
              <button onClick={() => { setMenuOpen(false); onNewSession?.() }} style={popupItemStyle}>
                <SquarePen size={14} />
                <span>{t('新会话', 'New Chat')}</span>
              </button>
            </div>
          )}
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
              ...inlineBtnRight,
              right: 44,
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
            style={{ ...inlineBtnRight, right: 12, color: 'rgba(255, 80, 80, 0.9)' }}
            title={t('挂断 (F2)', 'Hang up (F2)')}
          >
            <PhoneOff size={22} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
    <div
      key={closing ? 'closing' : 'open'}
      style={{
        ...barStyle,
        animation: closing
          ? 'claw-input-slide-down 0.2s ease-in forwards'
          : 'claw-input-slide-up 0.25s ease-out both',
      }}
    >
      <div style={{ flex: 1, position: 'relative' }}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          style={{ ...inlineBtnLeft, color: menuOpen ? 'rgba(100, 160, 255, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
          title={t('更多', 'More')}
        >
          <Plus size={22} />
        </button>
        {menuOpen && (
          <div style={popupMenuStyle}>
            <button onClick={() => { setMenuOpen(false); onHistoryOpen?.() }} style={popupItemStyle}>
              <History size={14} />
              <span>{t('对话历史', 'History')}</span>
            </button>
            <button onClick={() => { setMenuOpen(false); onNewSession?.() }} style={popupItemStyle}>
              <SquarePen size={14} />
              <span>{t('新会话', 'New Chat')}</span>
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onActiveChange?.(e.target.value.length > 0)
          }}
          onKeyDown={handleKeyDown}
          placeholder={sending ? t('思考中...', 'Thinking...') : ''}
          disabled={sending}
          style={{ ...inputStyle, paddingLeft: 48, paddingRight: 80 }}
          autoFocus
        />
        <button
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onMouseLeave={handleMouseLeave}
          style={{ ...inlineBtnRight, right: 44, color: recording ? 'rgba(255, 80, 80, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
          title={t('按住说话', 'Hold to speak')}
        >
          <Mic size={22} />
        </button>
        <button
          onClick={() => text.trim() ? send() : closeBar()}
          disabled={sending}
          style={{ ...inlineBtnRight, right: 12, color: text.trim() ? 'rgba(100, 160, 255, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
          title={text.trim() ? t('发送 (Enter)', 'Send (Enter)') : t('收起 (Esc)', 'Collapse (Esc)')}
        >
          {sending ? <Loader size={22} style={{ animation: 'spin 1s linear infinite' }} /> : text.trim() ? <Send size={22} /> : <ChevronDown size={22} />}
        </button>
      </div>
    </div>
    </>
  )
}

const fabStyle: React.CSSProperties = {
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
  boxSizing: 'border-box' as const,
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

const inlineBtnLeft: React.CSSProperties = {
  position: 'absolute',
  left: 12,
  top: '50%',
  transform: 'translateY(-50%)',
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
  zIndex: 2,
}

const inlineBtnRight: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
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
  zIndex: 1,
}

const popupMenuStyle: React.CSSProperties = {
  position: 'absolute',
  left: 4,
  bottom: '100%',
  marginBottom: 6,
  background: 'rgba(30, 30, 40, 0.95)',
  backdropFilter: 'blur(12px)',
  borderRadius: 10,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  zIndex: 1000,
}

const popupItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 14px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}
