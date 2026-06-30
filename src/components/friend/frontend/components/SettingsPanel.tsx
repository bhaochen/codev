import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Play, Loader } from 'lucide-react'
import { FRIEND_API } from '../api'

type SttProvider = 'browser' | 'groq' | 'anthropic' | 'local' | 'doubao'

interface SettingsPanelProps {
  visible: boolean
  onClose: () => void
  currentModel: string
  onModelChange: (path: string) => void
  hideUI: boolean
  onHideUIChange: (v: boolean) => void
  showText: boolean
  onShowTextChange: (v: boolean) => void
  ttsEnabled: boolean
  onTtsEnabledChange: (v: boolean) => void
  tracking: 'mouse' | 'camera'
  onTrackingChange: (v: 'mouse' | 'camera') => void
  volume: number
  onVolumeChange: (v: number) => void
  uiAlign: 'left' | 'right'
  onUiAlignChange: (v: 'left' | 'right') => void
  language: 'zh' | 'en'
  onLanguageChange: (v: 'zh' | 'en') => void
  sttProvider?: SttProvider
  onSttProviderChange?: (v: SttProvider) => void
}

type Tab = 'general' | 'voice' | 'model'

const BUILTIN_MODELS = ['/friend/model1.vrm', '/friend/model2.vrm', '/friend/model3.vrm', '/friend/model4.vrm', '/friend/model5.vrm']

const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 (女)' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓依 (女)' },
  { id: 'zh-CN-YunxiNeural', label: '云希 (男)' },
  { id: 'zh-CN-YunjianNeural', label: '云健 (男)' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵 (女)' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨 (女)' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱 (女)' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 (男)' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 (女)' },
  { id: 'ja-JP-NanamiNeural', label: 'Nanami (女)' },
  { id: 'en-US-MichelleNeural', label: 'Michelle (F)' },
  { id: 'en-US-GuyNeural', label: 'Guy (M)' },
]

const QWEN_VOICES = [
  { id: 'Cherry', label: '芊悦 - 阳光亲切 (女)' },
  { id: 'Serena', label: '苏瑶 - 温柔 (女)' },
  { id: 'Ethan', label: '晨煦 - 阳光温暖 (男)' },
  { id: 'Chelsie', label: '千雪 - 二次元 (女)' },
  { id: 'Momo', label: '茉兔 - 撒娇搞怪 (女)' },
  { id: 'Vivian', label: '十三 - 可爱小暴躁 (女)' },
  { id: 'Moon', label: '月白 - 率性帅气 (男)' },
  { id: 'Maia', label: '四月 - 知性温柔 (女)' },
  { id: 'Kai', label: '凯 - 耳朵SPA (男)' },
  { id: 'Nofish', label: '不吃鱼 - 设计师 (男)' },
  { id: 'Bella', label: '萌宝 - 小萝莉 (女)' },
  { id: 'Mia', label: '乖小妹 - 温顺乖巧 (女)' },
  { id: 'Mochi', label: '沙小弥 - 童真小大人 (男)' },
  { id: 'Bunny', label: '萌小姬 - 萌属性 (女)' },
  { id: 'Nini', label: '邻家妹妹 - 软糯甜蜜 (女)' },
  { id: 'Stella', label: '少女阿月 - 迷糊少女 (女)' },
  { id: 'Pip', label: '顽屁小孩 - 调皮捣蛋 (男)' },
  { id: 'Neil', label: '阿闻 - 新闻主持 (男)' },
  { id: 'Eldric Sage', label: '沧明子 - 沉稳老者 (男)' },
  { id: 'Vincent', label: '田叔 - 沙哑烟嗓 (男)' },
  { id: 'Bellona', label: '燕铮莺 - 有声书 (女)' },
  { id: 'Seren', label: '小婉 - 温柔助眠 (女)' },
]

const QWEN_MODELS = [
  { id: 'qwen3-tts-flash', label: 'Qwen3 TTS Flash' },
]

export function SettingsPanel({
  visible, onClose, currentModel, onModelChange,
  hideUI, onHideUIChange,
  showText, onShowTextChange,
  ttsEnabled, onTtsEnabledChange,
  tracking, onTrackingChange,
  volume, onVolumeChange,
  uiAlign, onUiAlignChange,
  language, onLanguageChange,
  sttProvider = 'browser', onSttProviderChange,
}: SettingsPanelProps) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh

  const [tab, setTab] = useState<Tab>('general')
  const [currentVoice, setCurrentVoice] = useState('')
  const [currentProvider, setCurrentProvider] = useState<string>('edge')
  const [qwenKey, setQwenKey] = useState('')
  const [qwenModel, setQwenModel] = useState('qwen3-tts-flash')
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Drag state
  const [panelPos, setPanelPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; origX: number; origY: number }>({
    dragging: false, startX: 0, startY: 0, origX: 0, origY: 0,
  })

  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: panelPos.x, origY: panelPos.y }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current.dragging) return
      setPanelPos({
        x: dragRef.current.origX + ev.clientX - dragRef.current.startX,
        y: dragRef.current.origY + ev.clientY - dragRef.current.startY,
      })
    }
    const onUp = () => {
      dragRef.current.dragging = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [panelPos])

  useEffect(() => {
    if (visible) setPanelPos({ x: 0, y: 0 })
  }, [visible])

  useEffect(() => {
    if (!visible) return
    fetch(`${FRIEND_API}/voice`)
      .then((r) => r.json())
      .then((data) => {
        setCurrentVoice(data.voice || '')
        setCurrentProvider(data.provider || 'edge')
        if (data.qwenKey) setQwenKey(data.qwenKey)
        if (data.qwenModel) setQwenModel(data.qwenModel)
      })
      .catch(() => {})
  }, [visible])

  const postVoiceSettings = (body: Record<string, string | undefined>) => {
    return fetch(`${FRIEND_API}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const saveModelPath = (modelPath: string) => {
    fetch(`${FRIEND_API}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath }),
    }).catch(() => {})
  }

  const setVoice = (voice: string) => {
    postVoiceSettings({ voice }).then(() => setCurrentVoice(voice)).catch(() => {})
  }

  const setProvider = (provider: string) => {
    postVoiceSettings({ provider }).then(() => setCurrentProvider(provider)).catch(() => {})
  }

  const saveQwenKey = (key: string) => {
    postVoiceSettings({ qwenKey: key }).catch(() => {})
  }

  const saveQwenModel = (model: string) => {
    postVoiceSettings({ qwenModel: model }).then(() => setQwenModel(model)).catch(() => {})
  }

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current = null
    }
    setPreviewingId(null)
  }, [])

  const preview = (voiceId: string) => {
    stopPreview()
    setPreviewingId(voiceId)
    fetch(`${FRIEND_API}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voiceId, provider: currentProvider }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.audioUrl) {
          const audio = new Audio(data.audioUrl)
          audioRef.current = audio
          audio.onended = () => stopPreview()
          audio.onerror = () => stopPreview()
          audio.play().catch(() => stopPreview())
        } else {
          if (data.error) console.warn('TTS preview error:', data.error)
          stopPreview()
        }
      })
      .catch(() => stopPreview())
  }

  if (!visible) return null

  const voices = currentProvider === 'qwen' ? QWEN_VOICES : EDGE_VOICES

  return (
    <div style={overlayStyle} data-no-passthrough onClick={onClose}>
      <div style={{ ...panelStyle, transform: `translate(${panelPos.x}px, ${panelPos.y}px)` }} data-no-passthrough onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle} onMouseDown={onDragStart}>
          <span style={{ fontSize: 16, fontWeight: 600, cursor: 'grab' }}>{t('设置', 'Settings')}</span>
          <button onClick={onClose} style={closeBtnStyle}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={tabBarStyle}>
          {(['general', 'voice', 'model'] as const).map((tb) => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              style={{ ...tabStyle, ...(tab === tb ? activeTabStyle : {}) }}
            >
              {{ general: t('常规', 'General'), voice: t('语音', 'Voice'), model: t('形象', 'Model') }[tb]}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={contentStyle}>
          {tab === 'general' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <LangToggle language={language} onChange={onLanguageChange} t={t} />
              <ToggleRow label={t('显示字幕', 'Subtitles')} value={showText} onChange={onShowTextChange} />
              <ToggleRow label={t('语音播报', 'TTS')} value={ttsEnabled} onChange={onTtsEnabledChange} />
              <VolumeControl volume={volume} onChange={onVolumeChange} t={t} />
              <TrackingControl tracking={tracking} onChange={onTrackingChange} t={t} />
              <UIAlignControl uiAlign={uiAlign} onChange={onUiAlignChange} t={t} />
              <ToggleRow label={t('隐藏UI', 'Hide UI')} value={hideUI} onChange={onHideUIChange} />
            </div>
          )}

          {tab === 'voice' && (
            <div style={sectionStyle}>
              <div style={labelStyle}>{t('TTS 服务', 'TTS Provider')}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['edge', 'qwen'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setProvider(p)}
                    style={{
                      ...modelBtnStyle,
                      flex: 1,
                      textAlign: 'center',
                      padding: '6px 10px',
                      fontSize: 13,
                      background: p === currentProvider ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                      borderColor: p === currentProvider ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                    }}
                  >
                    {{ edge: 'Edge', qwen: t('千问 TTS', 'Qwen TTS') }[p]}
                  </button>
                ))}
              </div>

              {currentProvider === 'qwen' && (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <div style={labelStyle}>{t('阿里云 API Key', 'Alibaba Cloud API Key')}</div>
                    <input
                      type="text"
                      value={qwenKey}
                      onChange={(e) => setQwenKey(e.target.value)}
                      onBlur={() => saveQwenKey(qwenKey)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveQwenKey(qwenKey) }}
                      placeholder="sk-..."
                      style={{ ...inputStyle, width: '100%' }}
                    />
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                      {t('从阿里云百炼控制台获取 API Key', 'Get API Key from Alibaba Cloud console')}
                    </div>
                  </div>
                  <div>
                    <div style={labelStyle}>{t('语音模型', 'Voice Model')}</div>
                    <select
                      value={qwenModel}
                      onChange={(e) => { setQwenModel(e.target.value); saveQwenModel(e.target.value) }}
                      style={selectStyle}
                    >
                      {QWEN_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 8 }}>
                <div style={labelStyle}>{t('语音识别 (STT)', 'Speech Recognition (STT)')}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(['browser', 'groq', 'anthropic', 'local', 'doubao'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => onSttProviderChange?.(p)}
                      style={{
                        ...smallBtnStyle,
                        flex: 1,
                        textAlign: 'center',
                        padding: '6px 10px',
                        fontSize: 12,
                        background: p === sttProvider ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: p === sttProvider ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      {{ browser: t('浏览器', 'Browser'), groq: 'Groq', anthropic: 'Anthropic', local: 'Whisper', doubao: 'Doubao' }[p]}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 8 }}>
                <div style={labelStyle}>{currentProvider === 'qwen' ? t('千问语音', 'Qwen Voice') : t('Edge TTS 语音', 'Edge TTS Voice')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                  {voices.map((v) => (
                    <div
                      key={v.id}
                      onClick={() => setVoice(v.id)}
                      style={{
                        ...modelBtnStyle,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 6px 6px 10px',
                        fontSize: 13,
                        background: v.id === currentVoice ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: v.id === currentVoice ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      <div>
                        <div>{v.label}</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>{v.id}</div>
                      </div>
                      <div
                        onClick={(e) => { e.stopPropagation(); preview(v.id) }}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: previewingId === v.id ? 'rgba(100, 160, 255, 0.3)' : 'rgba(255, 255, 255, 0.08)',
                          cursor: previewingId !== null ? 'default' : 'pointer',
                          flexShrink: 0,
                          opacity: previewingId !== null && previewingId !== v.id ? 0.3 : 0.7,
                        }}
                        title={t('试听', 'Preview')}
                      >
                        {previewingId === v.id ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'model' && (
            <div style={sectionStyle}>
              <div style={labelStyle}>{t('内置VRM模型', 'Built-in VRM Models')}</div>
              <select
                value={BUILTIN_MODELS.includes(currentModel) ? currentModel : ''}
                onChange={(e) => { onModelChange(e.target.value); saveModelPath(e.target.value) }}
                style={selectStyle}
              >
                {!BUILTIN_MODELS.includes(currentModel) && <option value="" disabled>{t('未选择', 'Not selected')}</option>}
                {BUILTIN_MODELS.map((m) => (
                  <option key={m} value={m}>{m.replace(/^\//, '')}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function LangToggle({ language, onChange, t }: { language: 'zh' | 'en'; onChange: (v: 'zh' | 'en') => void; t: (zh: string, en: string) => string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14 }}>{t('语言', 'Language')}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {(['zh', 'en'] as const).map((l) => (
          <button
            key={l}
            onClick={() => onChange(l)}
            style={{
              ...smallBtnStyle,
              background: language === l ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
              borderColor: language === l ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
            }}
          >
            {l === 'zh' ? '中文' : 'English'}
          </button>
        ))}
      </div>
    </div>
  )
}

function VolumeControl({ volume, onChange, t }: { volume: number; onChange: (v: number) => void; t: (zh: string, en: string) => string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14 }}>{t('音量', 'Volume')}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(volume * 100)}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
        />
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', width: 28, textAlign: 'right' }}>{Math.round(volume * 100)}</span>
      </div>
    </div>
  )
}

function TrackingControl({ tracking, onChange, t }: { tracking: 'mouse' | 'camera'; onChange: (v: 'mouse' | 'camera') => void; t: (zh: string, en: string) => string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14 }}>{t('视线跟随', 'Eye Tracking')}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {(['mouse', 'camera'] as const).map((m) => (
          <button
            key={m}
            onClick={() => onChange(m)}
            style={{
              ...smallBtnStyle,
              background: tracking === m ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
              borderColor: tracking === m ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
            }}
          >
            {m === 'mouse' ? t('鼠标', 'Mouse') : t('镜头', 'Camera')}
          </button>
        ))}
      </div>
    </div>
  )
}

function UIAlignControl({ uiAlign, onChange, t }: { uiAlign: 'left' | 'right'; onChange: (v: 'left' | 'right') => void; t: (zh: string, en: string) => string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14 }}>{t('UI位置', 'UI Position')}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {(['left', 'right'] as const).map((a) => (
          <button
            key={a}
            onClick={() => onChange(a)}
            style={{
              ...smallBtnStyle,
              background: uiAlign === a ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
              borderColor: uiAlign === a ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
            }}
          >
            {a === 'left' ? t('靠左', 'Left') : t('靠右', 'Right')}
          </button>
        ))}
      </div>
    </div>
  )
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        style={{
          ...toggleStyle,
          background: value ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
        }}
      >
        <div style={{
          ...toggleKnobStyle,
          transform: value ? 'translateX(18px)' : 'translateX(2px)',
        }} />
      </button>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  zIndex: 500,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
}

const panelStyle: React.CSSProperties = {
  width: 320,
  background: 'rgba(30, 30, 40, 0.95)',
  backdropFilter: 'blur(12px)',
  borderRadius: 12,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
  padding: 16,
  color: '#fff',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
  cursor: 'grab',
  userSelect: 'none',
}

const closeBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(255, 255, 255, 0.1)',
  color: 'rgba(255, 255, 255, 0.7)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  marginBottom: 16,
  background: 'rgba(255, 255, 255, 0.06)',
  borderRadius: 8,
  padding: 2,
}

const tabStyle: React.CSSProperties = {
  flex: 1,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'rgba(255, 255, 255, 0.6)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
}

const activeTabStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.12)',
  color: '#fff',
}

const contentStyle: React.CSSProperties = {
  minHeight: 120,
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'rgba(255, 255, 255, 0.6)',
  marginBottom: 2,
}

const toggleStyle: React.CSSProperties = {
  width: 40,
  height: 22,
  borderRadius: 11,
  border: 'none',
  cursor: 'pointer',
  position: 'relative',
  transition: 'background 0.2s',
  padding: 0,
}

const toggleKnobStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 9,
  background: '#fff',
  transition: 'transform 0.2s',
  position: 'absolute',
  top: 2,
}

const smallBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
}

const modelBtnStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid',
  borderRadius: 8,
  color: '#fff',
  fontSize: 14,
  cursor: 'pointer',
  textAlign: 'left',
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  height: 32,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.3)',
  color: '#fff',
  fontSize: 13,
  padding: '0 8px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  height: 32,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.3)',
  color: '#fff',
  fontSize: 13,
  padding: '0 8px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}
