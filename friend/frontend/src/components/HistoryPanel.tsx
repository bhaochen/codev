import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import { FRIEND_API } from '../api'

interface HistoryMessage {
  role: string
  content: string
  timestamp?: number
}

interface HistoryPanelProps {
  visible: boolean
  onClose: () => void
  language?: 'zh' | 'en'
}

export function HistoryPanel({ visible, onClose, language = 'zh' }: HistoryPanelProps) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const [messages, setMessages] = useState<HistoryMessage[]>([])
  const [agentName, setAgentName] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  // Fetch history when panel opens
  useEffect(() => {
    if (!visible) return
    setLoading(true)
    fetch(`${FRIEND_API}/history`)
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.messages || [])
        if (data.agentName) setAgentName(data.agentName)
        setTimeout(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }, 50)
      })
      .catch(() => setMessages([]))
      .finally(() => setLoading(false))
  }, [visible])

  if (!visible) return null

  return (
    <div style={overlayStyle} data-no-passthrough onClick={onClose}>
      <div style={{ ...panelStyle, transform: `translate(${panelPos.x}px, ${panelPos.y}px)` }} data-no-passthrough onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle} onMouseDown={onDragStart}>
          <span style={{ fontSize: 16, fontWeight: 600, cursor: 'grab' }}>{t('对话历史', 'Chat History')}</span>
          <button onClick={onClose} style={closeBtnStyle}>
            <X size={16} />
          </button>
        </div>

        <div ref={scrollRef} style={messagesContainerStyle}>
          {loading && (
            <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', padding: 20 }}>{t('加载中...', 'Loading...')}</div>
          )}
          {!loading && messages.length === 0 && (
            <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', padding: 20 }}>{t('暂无对话记录', 'No chat history')}</div>
          )}
          {messages.map((msg, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 2 }}>
                {msg.role === 'user' ? t('你', 'You') : (agentName || 'AI')}
              </div>
              <div style={{
                ...bubbleStyle,
                background: msg.role === 'user' ? 'rgba(100, 160, 255, 0.3)' : 'rgba(255, 255, 255, 0.08)',
                borderColor: msg.role === 'user' ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.12)',
              }}>
                {msg.content}
              </div>
            </div>
          ))}
        </div>
      </div>
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
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
}

const panelStyle: React.CSSProperties = {
  width: 360,
  maxHeight: '80vh',
  background: 'rgba(30, 30, 40, 0.95)',
  backdropFilter: 'blur(12px)',
  borderRadius: 12,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
  padding: 16,
  color: '#fff',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
  display: 'flex',
  flexDirection: 'column',
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

const messagesContainerStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxHeight: 'calc(80vh - 60px)',
}

const bubbleStyle: React.CSSProperties = {
  maxWidth: '85%',
  padding: '8px 12px',
  borderRadius: 10,
  border: '1px solid',
  fontSize: 13,
  lineHeight: 1.5,
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
}
