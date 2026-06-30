import { useEffect, useRef, useState, useCallback } from 'react'
import { VRMScene } from './components/VRMScene'
import type { VRMSceneHandle } from './components/VRMScene'
import { TextBubble } from './components/TextBubble'
import type { OnVrmMessage } from './components/TextBubble'
import { ChatInput } from './components/ChatInput'
import { ResizeHandles } from './components/ResizeHandles'
import { SettingsPanel } from './components/SettingsPanel'
import { usePassThrough } from './hooks/usePassThrough'
import { LipSync } from './lip-sync'
import { FRIEND_API, bindScene } from './api'
import { Menu, Move, Rotate3D, EyeOff, Settings, RefreshCw, Pin } from 'lucide-react'

const DEFAULT_MODEL = '/friend/model1.vrm'

// 情绪 → 动作映射
// 只有有明确肢体动作关联的情绪才映射；neutral/relaxed 不绑动作，
// 避免角色在无明确意图时做出违和姿势。
const emotionActionMap: Record<string, string> = {
  think: 'scratchHead',
  question: 'point',
  curious: 'scratchHead',
  happy: 'happy',
  surprised: 'excited',
  angry: 'angry',
  awkward: 'playFingers',
  love: 'shy',
  flirty: 'shy',
  greeting: 'greeting',
  sad: '',
  relaxed: '',
  neutral: '',
}

const btnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(125, 125, 125, 0.28)',
  backdropFilter: 'blur(6px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 16,
  cursor: 'pointer',
}

export default function App() {
  const sceneRef = useRef<VRMSceneHandle>(null)
  const [pinned, setPinned] = useState(true)
  const [tracking, setTracking] = useState<'mouse' | 'camera'>('mouse')
  const [showText, setShowText] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [modelPath, setModelPath] = useState(DEFAULT_MODEL)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [hideUI, setHideUI] = useState(false)
  const [volume, setVolume] = useState(0.5)
  const [uiAlign, setUiAlign] = useState<'left' | 'right'>('right')
  const [language, setLanguage] = useState<'zh' | 'en'>(() => navigator.language.startsWith('zh') ? 'zh' : 'en')
  const [sttProvider, setSttProvider] = useState<'browser' | 'groq' | 'anthropic' | 'local' | 'doubao'>('browser')
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  usePassThrough(!settingsOpen)

  // Load persisted settings on mount
  useEffect(() => {
    fetch(`${FRIEND_API}/settings`)
      .then((r) => r.json())
      .then((s) => {
        if (s.modelPath) setModelPath(s.modelPath)
        if (s.ttsEnabled !== undefined) setTtsEnabled(s.ttsEnabled)
        if (s.showText !== undefined) setShowText(s.showText)
        if (s.hideUI !== undefined) setHideUI(s.hideUI)
        if (s.tracking) { setTracking(s.tracking); sceneRef.current?.setTrackingMode(s.tracking) }
        if (s.volume !== undefined) { setVolume(s.volume); LipSync.getInstance().setVolume(s.volume) }
        if (s.uiAlign) setUiAlign(s.uiAlign)
        if (s.sttProvider) setSttProvider(s.sttProvider)
        if (s.language) {
          setLanguage(s.language)
        } else {
          const detected = navigator.language.startsWith('zh') ? 'zh' : 'en'
          fetch(`${FRIEND_API}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language: detected }),
          }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  const saveSettings = (patch: Record<string, unknown>) => {
    fetch(`${FRIEND_API}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {})
  }

  useEffect(() => {
    bindScene(sceneRef.current)
    return () => bindScene(null)
  })

  const handleVolumeChange = useCallback((v: number) => {
    setVolume(v)
    LipSync.getInstance().setVolume(v)
    saveSettings({ volume: v })
  }, [])

  const handleTrackingChange = useCallback((mode: 'mouse' | 'camera') => {
    sceneRef.current?.setTrackingMode(mode)
    setTracking(mode)
    saveSettings({ tracking: mode })
  }, [])

  const handleVrmMessage: OnVrmMessage = useCallback((msg) => {
    if (msg.emotion && sceneRef.current) {
      const action = msg.action || emotionActionMap[msg.emotion]
      if (msg.text) {
        sceneRef.current.setEmotionWithReset(msg.emotion, msg.emotionDuration ?? 5000, msg.emotionIntensity)
        if (action) sceneRef.current.playAction(action)
      } else {
        sceneRef.current.setEmotionWithReset(msg.emotion, msg.emotionDuration ?? 10000, msg.emotionIntensity)
        // No hold — action plays once, emotion timer handles duration.
        // Hold would lock _actionPlaying for 10s, blocking text-message actions
        // when friend_emotion tool fires before broadcastResponse.
        if (action) sceneRef.current.playAction(action)
      }
    }
  }, [])

  // ── Idle fidget: natural micro-movements when no activity ─────────────────
  const lastActivityRef = useRef(Date.now())
  const originalHandleVrmMessage = handleVrmMessage
  const handleVrmMessageWithActivity: OnVrmMessage = useCallback((msg) => {
    lastActivityRef.current = Date.now()
    originalHandleVrmMessage(msg)
  }, [originalHandleVrmMessage])

  useEffect(() => {
    const allEmotions = [
      'happy', 'sad', 'angry', 'surprised', 'think', 'awkward',
      'question', 'curious', 'neutral', 'love', 'flirty', 'greeting', 'relaxed',
    ]
    const idleTimers: Array<{ emotion?: string; action?: string; minIdle: number }> = [
      // Emotion-only (subtle facial changes, no body action)
      { emotion: 'think',   minIdle: 8 },
      { emotion: 'curious', minIdle: 12 },
      { emotion: 'relaxed', minIdle: 15 },
      { emotion: 'happy',   minIdle: 20 },
      // Small body actions (no strong emotion)
      { action: 'stretch',       minIdle: 25 },
      { action: 'scratchHead',   minIdle: 10 },
      { action: 'playFingers',   minIdle: 15 },
      { action: 'akimbo',        minIdle: 30 },
      // Combined emotion + action
      { emotion: 'think',   action: 'scratchHead', minIdle: 18 },
      { emotion: 'relaxed', action: 'akimbo',      minIdle: 35 },
      { emotion: 'curious', action: 'point',       minIdle: 22 },
      { emotion: 'happy',   action: 'shy',         minIdle: 28 },
      { emotion: 'surprised', action: 'excited',   minIdle: 40 },
    ]
    const IDLE_THRESHOLD_MS = 15_000
    const FIDGET_CHECK_MS = 8_000

    const timer = setInterval(() => {
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs < IDLE_THRESHOLD_MS) return
      if (Math.random() > 0.55) return

      // Pick a weighted-random fidget based on how long we've been idle
      const candidates = idleTimers.filter((t) => idleMs >= t.minIdle * 1000)
      if (candidates.length === 0) return
      const pick = candidates[Math.floor(Math.random() * candidates.length)]

      if (pick.emotion) {
        const intensity = 0.3 + Math.random() * 0.5
        const duration = 2000 + Math.random() * 3000
        sceneRef.current?.setEmotionWithReset(pick.emotion, duration, intensity)
      }
      if (pick.action) {
        sceneRef.current?.playAction(pick.action)
      }
      lastActivityRef.current = Date.now()
    }, FIDGET_CHECK_MS)

    return () => clearInterval(timer)
  }, [])

  // 全局快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Tab') {
        e.preventDefault()
        setCollapsed((v) => !v)
      }
      if (e.key === 'F4') {
        e.preventDefault()
        setSettingsOpen((v) => !v)
      }
      if (e.key === 'F5') {
        e.preventDefault()
        window.location.reload()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const togglePin = async () => {
    setPinned((v) => !v)
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <ResizeHandles />
      <VRMScene ref={sceneRef} modelPath={modelPath} />
      <TextBubble onMessage={handleVrmMessageWithActivity} enabled={showText} ttsEnabled={ttsEnabled} />
      {!hideUI && <ChatInput uiAlign={uiAlign} language={language} sttProvider={sttProvider} />}
      <SettingsPanel
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        currentModel={modelPath}
        onModelChange={(m) => { setModelPath(m); saveSettings({ modelPath: m }) }}
        hideUI={hideUI}
        onHideUIChange={(v) => { setHideUI(v); saveSettings({ hideUI: v }) }}
        showText={showText}
        onShowTextChange={(v) => { setShowText(v); saveSettings({ showText: v }) }}
        ttsEnabled={ttsEnabled}
        onTtsEnabledChange={(v) => { setTtsEnabled(v); saveSettings({ ttsEnabled: v }) }}
        tracking={tracking}
        onTrackingChange={handleTrackingChange}
        volume={volume}
        onVolumeChange={handleVolumeChange}
        uiAlign={uiAlign}
        onUiAlignChange={(v) => { setUiAlign(v); saveSettings({ uiAlign: v }) }}
        language={language}
        onLanguageChange={(v) => { setLanguage(v); saveSettings({ language: v }) }}
        sttProvider={sttProvider}
        onSttProviderChange={(v) => { setSttProvider(v); saveSettings({ sttProvider: v }) }}
      />
      {!hideUI && <div
        style={{
          position: 'absolute',
          top: 8,
          ...(uiAlign === 'left' ? { left: 8 } : { right: 8 }),
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <button
          onClick={() => setCollapsed((v) => !v)}
          style={btnStyle}
          title={collapsed ? t('展开菜单 (Tab)', 'Expand Menu (Tab)') : t('折叠菜单 (Tab)', 'Collapse Menu (Tab)')}
        >
          <Menu size={16} />
        </button>
        {!collapsed && <>
          <button
            onClick={() => setSettingsOpen(true)}
            style={btnStyle}
            title={t('设置 (F4)', 'Settings (F4)')}
          >
            <Settings size={16} />
          </button>
          <button
            onClick={() => window.location.reload()}
            style={btnStyle}
            title={t('刷新 (F5)', 'Refresh (F5)')}
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => window.close()}
            style={btnStyle}
            title={t('隐藏窗口', 'Hide Window')}
          >
            <EyeOff size={16} />
          </button>
          <button
            onClick={togglePin}
            style={{ ...btnStyle, opacity: pinned ? 1 : 0.5 }}
            title={pinned ? t('取消置顶', 'Unpin') : t('置顶窗口', 'Pin to Top')}
          >
            <Pin size={16} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              ;(window as any).__clawDragging = true
              let lastX = e.clientX
              let lastY = e.clientY
              const onMove = (ev: MouseEvent) => {
                sceneRef.current?.panCamera(ev.clientX - lastX, ev.clientY - lastY)
                lastX = ev.clientX
                lastY = ev.clientY
              }
              const onUp = () => {
                ;(window as any).__clawDragging = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            style={{ ...btnStyle, cursor: 'grab' }}
            title={t('拖动移动人物位置', 'Drag to Move')}
          >
            <Move size={16} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              ;(window as any).__clawDragging = true
              let lastX = e.clientX
              let lastY = e.clientY
              const onMove = (ev: MouseEvent) => {
                sceneRef.current?.rotateCamera(ev.clientX - lastX, ev.clientY - lastY)
                lastX = ev.clientX
                lastY = ev.clientY
              }
              const onUp = () => {
                ;(window as any).__clawDragging = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            style={{ ...btnStyle, cursor: 'grab' }}
            title={t('拖动旋转视角', 'Drag to Rotate')}
          >
            <Rotate3D size={16} />
          </button>
        </>}
      </div>}
    </div>
  )
}
