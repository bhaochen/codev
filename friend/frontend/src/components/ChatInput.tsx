import { useState, useRef, useCallback, useEffect } from 'react'
import { MessageCircle, Send, Loader, Mic, ChevronDown, History, SquarePen, Plus, Phone, PhoneOff } from 'lucide-react'
import { FRIEND_API } from '../api'

// Keyframes (claw-input-slide-up, claw-input-slide-down, claw-pulse) are in index.html <style>

const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

export function ChatInput({ visible = true, onActiveChange, uiAlign = 'right', onHistoryOpen, onNewSession, language = 'zh' }: { visible?: boolean; onActiveChange?: (hasText: boolean) => void; uiAlign?: 'left' | 'right'; onHistoryOpen?: () => void; onNewSession?: () => void; language?: 'zh' | 'en' }) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [closing, setClosing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [voiceCallActive, setVoiceCallActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<any>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSentIndexRef = useRef(0)
  const voiceCallActiveRef = useRef(false)

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
    // Web Speech API (Tauri native STT not available in web mode)
    if (!SpeechRecognition) {
      console.error('SpeechRecognition not supported')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = true

    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      setText(transcript)
      onActiveChange?.(transcript.length > 0)
    }

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error)
      setRecording(false)
    }

    recognition.onend = () => {
      setRecording(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }

    recognition.start()
    recognitionRef.current = recognition
    setRecording(true)
    setOpen(true)
  }, [])

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setRecording(false)
  }, [])

  // 鼠标移出按钮时也停止录音
  const handleMouseLeave = useCallback(() => {
    if (recording) stopRecording()
  }, [recording, stopRecording])

  // --- Voice Call: constants ---
  const HARD_PUNCT = /[。！？\.\!\?]$/        // immediate send
  const SOFT_PUNCT = /[，、；,;：:]$/           // send if long enough
  const SOFT_PUNCT_MIN_LEN = 10               // min chars before soft punct triggers send
  const MAX_UNSENT_LEN = 30                   // force send when accumulated text is this long
  const SILENCE_SEND_MS = 1200                // silence fallback timeout
  const VAD_RMS_THRESHOLD = 0.015             // RMS below this = silence
  const VAD_SILENCE_TIMEOUT_MS = 15_000       // stop STT after 15s silence

  // --- Voice Call: delayed TTS interrupt ---
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleInterrupt = useCallback(() => {
    if (interruptTimerRef.current) return // already scheduled
    interruptTimerRef.current = setTimeout(() => {
      interruptTimerRef.current = null
      ;(window as any).__clawInterruptAudio?.()
    }, 1000)
  }, [])
  const cancelInterrupt = useCallback(() => {
    if (interruptTimerRef.current) { clearTimeout(interruptTimerRef.current); interruptTimerRef.current = null }
  }, [])

  // --- Voice Call: refs ---
  const vadStreamRef = useRef<MediaStream | null>(null)
  const vadContextRef = useRef<AudioContext | null>(null)
  const vadAnalyserRef = useRef<AnalyserNode | null>(null)
  const vadRafRef = useRef<number>(0)
  const vadSpeakingRef = useRef(false)
  const vadSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [vadSpeaking, setVadSpeaking] = useState(false)

  // --- Voice Call: send + mute capture for 3s after send ---
  const VOICE_MUTE_AFTER_SEND_MS = 2000
  const mutedUntilRef = useRef(0)

  const voiceCallSend = useCallback(async (msg: string) => {
    const trimmed = msg.trim()
    if (!trimmed) return
    mutedUntilRef.current = Date.now() + VOICE_MUTE_AFTER_SEND_MS
    cancelInterrupt()
    ;(window as any).__clawInterruptAudio?.()
    try {
      await fetch(`${FRIEND_API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      })
    } catch (err) {
      console.error('Voice call send failed:', err)
    }
  }, [cancelInterrupt])

  // --- Voice Call: smart sentence segmentation ---
  const handleVoiceCallResult = useCallback((fullTranscript: string, isFinal: boolean) => {
    // Ignore STT results during post-send mute period
    if (Date.now() < mutedUntilRef.current) {
      lastSentIndexRef.current = fullTranscript.length
      return
    }

    const unsent = fullTranscript.slice(lastSentIndexRef.current)
    setText(unsent)
    onActiveChange?.(unsent.length > 0)

    // Reset silence send timer on any result
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }

    if (isFinal) {
      const shouldSend =
        HARD_PUNCT.test(unsent) ||                                       // hard punctuation
        (SOFT_PUNCT.test(unsent) && unsent.length >= SOFT_PUNCT_MIN_LEN) || // soft punct + long enough
        unsent.length >= MAX_UNSENT_LEN                                  // word count overflow

      if (shouldSend) {
        voiceCallSend(unsent)
        lastSentIndexRef.current = fullTranscript.length
        setText('')
        onActiveChange?.(false)
        return
      }
    }

    // Silence fallback: start timer on both partial and final results
    if (unsent.trim()) {
      silenceTimerRef.current = setTimeout(() => {
        if (!voiceCallActiveRef.current) return
        const chunk = unsent.trim()
        if (chunk) {
          voiceCallSend(chunk)
          lastSentIndexRef.current = fullTranscript.length
          setText('')
          onActiveChange?.(false)
        }
      }, SILENCE_SEND_MS)
    }
  }, [voiceCallSend, onActiveChange])

  // --- Voice Call: VAD using AnalyserNode ---
  const startVad = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      vadStreamRef.current = stream
      const ctx = new AudioContext()
      vadContextRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      vadAnalyserRef.current = analyser

      const dataArray = new Float32Array(analyser.fftSize)
      let lastSpeechTime = performance.now()

      const check = () => {
        if (!voiceCallActiveRef.current) return
        analyser.getFloatTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i]
        const rms = Math.sqrt(sum / dataArray.length)

        const speaking = rms > VAD_RMS_THRESHOLD
        if (speaking) {
          lastSpeechTime = performance.now()
          if (!vadSpeakingRef.current) {
            vadSpeakingRef.current = true
            setVadSpeaking(true)
            // Interrupt TTS after 1s delay when user starts speaking
            scheduleInterrupt()
          }
        } else if (vadSpeakingRef.current && performance.now() - lastSpeechTime > 500) {
          vadSpeakingRef.current = false
          cancelInterrupt()
          setVadSpeaking(false)
        }

        vadRafRef.current = requestAnimationFrame(check)
      }
      vadRafRef.current = requestAnimationFrame(check)
    } catch (err) {
      console.error('VAD start failed:', err)
    }
  }, [])

  const stopVad = useCallback(() => {
    if (vadRafRef.current) { cancelAnimationFrame(vadRafRef.current); vadRafRef.current = 0 }
    vadStreamRef.current?.getTracks().forEach((t) => t.stop())
    vadStreamRef.current = null
    vadContextRef.current?.close()
    vadContextRef.current = null
    vadAnalyserRef.current = null
    vadSpeakingRef.current = false
    setVadSpeaking(false)
    if (vadSilenceTimerRef.current) { clearTimeout(vadSilenceTimerRef.current); vadSilenceTimerRef.current = null }
  }, [])

  // --- Voice Call: start ---
  const startVoiceCall = useCallback(async () => {
    setVoiceCallActive(true)
    voiceCallActiveRef.current = true
    lastSentIndexRef.current = 0
    setText('')
    setOpen(true)

    // Start VAD
    await startVad()

    if (!SpeechRecognition) {
      console.error('SpeechRecognition not supported')
      setVoiceCallActive(false)
      voiceCallActiveRef.current = false
      stopVad()
      return
    }

    const startWebSTT = () => {
      const recognition = new SpeechRecognition()
      recognition.lang = 'zh-CN'
      recognition.interimResults = true
      recognition.continuous = true
      recognitionRef.current = recognition

      recognition.onresult = (event: any) => {
        let transcript = ''
        let latestFinalEnd = 0
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript
          if (event.results[i].isFinal) latestFinalEnd = transcript.length
        }
        const hasFinal = latestFinalEnd > lastSentIndexRef.current
        handleVoiceCallResult(transcript, hasFinal)
      }

      recognition.onerror = (event: any) => {
        console.error('Voice call STT error:', event.error)
        if (event.error === 'no-speech' || event.error === 'aborted') return
      }

      recognition.onend = () => {
        // Auto-restart if call is still active
        if (voiceCallActiveRef.current) {
          lastSentIndexRef.current = 0
          setTimeout(() => {
            if (voiceCallActiveRef.current) startWebSTT()
          }, 300)
        }
      }

      recognition.start()
      setRecording(true)
    }

    startWebSTT()
  }, [handleVoiceCallResult, startVad, stopVad])

  // --- Voice Call: end ---
  const endVoiceCall = useCallback(() => {
    voiceCallActiveRef.current = false
    setVoiceCallActive(false)

    // Stop VAD
    stopVad()

    // Stop STT
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setRecording(false)

    // Clear timers
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }
    cancelInterrupt()
    mutedUntilRef.current = 0

    setText('')
    setOpen(false)
    onActiveChange?.(false)
  }, [onActiveChange, stopVad, cancelInterrupt])

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

  // 全局快捷键
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (!visible) return
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

      // Enter: 唤起输入框 / 聚焦输入框
      if (e.key === 'Enter' && !e.shiftKey && !inInput) {
        e.preventDefault()
        if (!open) {
          setMenuOpen(false)
          setOpen(true)
        }
        setTimeout(() => inputRef.current?.focus(), 50)
      }

      // Escape: 收起输入框
      if (e.key === 'Escape' && open && !inInput) {
        e.preventDefault()
        closeBar()
      }

      // F2: 语音通话
      if (e.key === 'F2') {
        e.preventDefault()
        if (voiceCallActive) {
          endVoiceCall()
        } else {
          startVoiceCall()
        }
      }
    }
    const onGlobalKeyUp = (_e: KeyboardEvent) => {
      // F2 keyup no longer needed (voice call is toggle, not push-to-talk)
    }
    window.addEventListener('keydown', onGlobalKeyDown)
    window.addEventListener('keyup', onGlobalKeyUp)
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown)
      window.removeEventListener('keyup', onGlobalKeyUp)
    }
  }, [open, visible, recording, voiceCallActive, startRecording, stopRecording, closeBar, startVoiceCall, endVoiceCall])

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
          {/* 左侧 + 号按钮 */}
          <button
            onClick={() => setMenuOpen((v) => !v)}
            style={{ ...inlineBtnLeft, color: menuOpen ? 'rgba(100, 160, 255, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
            title={t('更多', 'More')}
          >
            <Plus size={22} />
          </button>
          {/* 弹出菜单 */}
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
              borderColor: vadSpeaking ? 'rgba(255, 80, 80, 0.7)' : 'rgba(255, 80, 80, 0.25)',
            }}
            data-no-passthrough
          >
            <span style={{ color: text ? '#fff' : 'rgba(255, 255, 255, 0.45)', fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' }}>
              {text || (vadSpeaking ? t('正在听...', 'Listening...') : t('等待说话...', 'Waiting to speak...'))}

            </span>
          </div>
          {/* 右侧：麦克风指示 + 挂断 */}
          <span
            style={{
              ...inlineBtnRight,
              right: 44,
              color: vadSpeaking ? 'rgba(255, 80, 80, 0.9)' : 'rgba(80, 200, 120, 0.9)',
              animation: vadSpeaking ? 'claw-pulse 0.8s ease-in-out infinite' : 'none',
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
        {/* 左侧 + 号按钮 */}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          style={{ ...inlineBtnLeft, color: menuOpen ? 'rgba(100, 160, 255, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
          title={t('更多', 'More')}
        >
          <Plus size={22} />
        </button>
        {/* 弹出菜单 */}
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
        {/* 右侧：发送/收起 */}
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

