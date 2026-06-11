import { useEffect, useRef, useState, useCallback } from 'react'
import { useCompanionStore, SCENARIOS } from '../stores/companionStore'
import { ScenarioSelector } from '../components/companion/ScenarioSelector'
import {
  fetchServiceStatus,
  fetchPresets,
  submitChatNonStreaming,
  submitChatStreaming,
  StreamingPcmPlayer,
  createMicCapture,
  prewarmMic,
  setCapturing,
  coldDownMic,
  finalizeRecordingChunks,
  downscaleImageToAttachment,
  mediaFileToAttachment,
  float32ToWavBlobUrl,
} from '../hooks/useMiniCPMoBackend'
import type { MiniCPMoMessage, MiniCPMoAttachment } from '../types/companion'
import type { MiniCPMoSession } from '../stores/companionStore'

// ─── Helpers ─────────────────────────────────────────────

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

const CANCEL_DRAG_PX = 80

function formatDurationMs(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  const d = new Date(ts)
  const today = new Date()
  if (today.getFullYear() === d.getFullYear() && today.getMonth() === d.getMonth() && today.getDate() === d.getDate()) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  const yesterday = new Date(Date.now() - 86_400_000)
  if (yesterday.getFullYear() === d.getFullYear() && yesterday.getMonth() === d.getMonth() && yesterday.getDate() === d.getDate()) {
    return '昨天'
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function deriveSessionTitle(messages: MiniCPMoMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (m.kind === 'text' && m.text.trim()) {
      const txt = m.text.trim().replace(/\s+/g, ' ')
      return txt.length > 28 ? `${txt.slice(0, 28)}…` : txt
    }
    if (m.kind === 'voice') return '语音消息'
    if (m.kind === 'text' && m.attachments?.length) {
      const a = m.attachments[0]
      if (a && a.kind === 'image') return '图片消息'
      if (a && a.kind === 'audio') return '音频消息'
      if (a && a.kind === 'video') return '视频消息'
    }
  }
  return '新的对话'
}

// ─── SVG Icon Components ─────────────────────────────────

function IconHamburger({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M4.5 7h15M4.5 12h15M4.5 17h15" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

function IconSettings({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M10.3 4.8h3.4l.5 2.1a5.8 5.8 0 0 1 1.5.9l2-.7 1.7 2.9-1.5 1.4a6 6 0 0 1 0 1.7l1.5 1.4-1.7 2.9-2-.7a5.8 5.8 0 0 1-1.5.9l-.5 2.1h-3.4l-.5-2.1a5.8 5.8 0 0 1-1.5-.9l-2 .7-1.7-2.9 1.5-1.4a6 6 0 0 1 0-1.7L4.6 10l1.7-2.9 2 .7a5.8 5.8 0 0 1 1.5-.9Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function IconSend({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M4.5 11.5 19 5l-4.5 14-2.6-5-7.4-2.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M19 5 11.8 14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

function IconStop({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <rect x="7" y="7" width="10" height="10" rx="2.4" fill="currentColor" />
    </svg>
  )
}

function IconKeyboard({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <rect x="3.5" y="6" width="17" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.5 10h9M7.5 13h4.5M14 13h2.5M7.5 16h7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

function IconWave({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M4 13h2l1.4-4 2.4 9 2.4-12 2.1 7H20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  )
}

function IconPlus({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="m8 8 8 8M16 8l-8 8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

function IconPlay({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M9 7.5v9l7-4.5-7-4.5Z" fill="currentColor" />
    </svg>
  )
}

function IconPause({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <rect x="7" y="6" width="3.2" height="12" rx="1.2" fill="currentColor" />
      <rect x="13.8" y="6" width="3.2" height="12" rx="1.2" fill="currentColor" />
    </svg>
  )
}

function IconSpeaker({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M11 5 6.5 9H3.5C2.67 9 2 9.67 2 10.5v3c0 .83.67 1.5 1.5 1.5h3L11 19V5Z" fill="currentColor" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M18.36 5.64a9 9 0 0 1 0 12.73" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function IconCamera({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M5 9.5A2.5 2.5 0 0 1 7.5 7h1.6l1.4-2h3l1.4 2h1.6A2.5 2.5 0 0 1 19 9.5v7A2.5 2.5 0 0 1 16.5 19h-9A2.5 2.5 0 0 1 5 16.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function IconPhoto({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
      <circle cx="9" cy="10.5" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.7 16.5 9 12l4 3.5 3-2.5 4.3 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  )
}

function IconFile({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M14 3.5H7.5A2 2 0 0 0 5.5 5.5v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.2L14 3.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
      <path d="M13.5 3.5v4.7h5" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  )
}

function IconCopy({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <rect x="8.5" y="8.5" width="10" height="11" rx="2.2" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
      <path d="M15.5 6h-7A2 2 0 0 0 6.5 8v9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  )
}

function IconRefresh({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M5.5 12a6.5 6.5 0 0 1 11.2-4.5L19 10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M19 5v5h-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M18.5 12a6.5 6.5 0 0 1-11.2 4.5L5 14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M5 19v-5h5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  )
}

function IconTrash({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M5 7h14M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7m-7.5 0 .8 11.2a1.8 1.8 0 0 0 1.8 1.6h6.8a1.8 1.8 0 0 0 1.8-1.6L17.5 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
      <path d="M10.5 11v5M13.5 11v5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
  )
}

function IconEdit({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <path d="M5 6.8A2.2 2.2 0 0 1 7.2 4.6h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <path d="M19.4 11v5.8a2.2 2.2 0 0 1-2.2 2.2H7.2A2.2 2.2 0 0 1 5 16.8V11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <path d="m13.6 11.5 6-6a1.6 1.6 0 0 1 2.3 2.3l-6 6-2.7.4.4-2.7Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  )
}

// ─── Audio Play Pill ────────────────────────────────────

function AudioPlayPill({ url, className = '' }: { url: string; className?: string }) {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const audio = new Audio(url)
    audioRef.current = audio
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => setPlaying(false)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      try { audio.pause() } catch { /* ignore */ }
      audioRef.current = null
    }
  }, [url])

  return (
    <button
      type="button"
      onClick={() => {
        const a = audioRef.current
        if (!a) return
        if (playing) { a.pause(); return }
        try { a.currentTime = 0 } catch { /* ignore */ }
        void a.play().catch(() => setPlaying(false))
      }}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors ${
        playing ? 'bg-orange-500/30 text-orange-200' : 'bg-white/10 text-white/70 hover:bg-white/20'
      } ${className}`}
    >
      {playing
        ? <IconPause className="w-3.5 h-3.5" />
        : <IconPlay className="w-3.5 h-3.5" />
      }
      <span>{playing ? '暂停' : '播放'}</span>
    </button>
  )
}

// ─── Copy Button ────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
          setCopied(true)
        } catch { /* ignore */ }
      }}
      className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70 transition-colors"
      title={copied ? '已复制' : '复制'}
    >
      <IconCopy className="w-3.5 h-3.5" />
    </button>
  )
}

// ─── Message Attachment ─────────────────────────────────

function MessageAttachment({ attachment }: { attachment: MiniCPMoAttachment }) {
  if (attachment.kind === 'image') {
    return <img src={attachment.previewUrl} alt={attachment.name} className="max-w-full rounded-lg mb-1 max-h-60 object-cover" />
  }
  if (attachment.kind === 'audio') {
    return <AudioPlayPill url={attachment.previewUrl} className="mb-1" />
  }
  return (
    <video src={attachment.previewUrl} controls preload="metadata" playsInline className="max-w-full rounded-lg mb-1 max-h-60" />
  )
}

// ─── Message Bubble ─────────────────────────────────────

function MessageBubble({
  msg,
  isLastAssistant,
  isStreaming,
  onRegenerate,
}: {
  msg: MiniCPMoMessage
  isLastAssistant: boolean
  isStreaming: boolean
  onRegenerate?: () => void
}) {
  const [audioPlaying, setAudioPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const audioUrl = msg.role === 'assistant' && msg.audioPreviewUrl ? msg.audioPreviewUrl : null

  useEffect(() => {
    if (!audioUrl) return
    const audio = new Audio(audioUrl)
    audioRef.current = audio
    const onPlay = () => setAudioPlaying(true)
    const onPause = () => setAudioPlaying(false)
    const onEnded = () => setAudioPlaying(false)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      try { audio.pause() } catch { /* ignore */ }
      audioRef.current = null
    }
  }, [audioUrl])

  if (msg.role === 'user' && msg.kind === 'voice') {
    const voiceAtts = msg.attachments ?? []
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%]">
          {voiceAtts.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1 justify-end">
              {voiceAtts.map((a) => <MessageAttachment key={a.id} attachment={a} />)}
            </div>
          )}
          <div className="bg-orange-500/20 text-white rounded-2xl rounded-br-md px-3.5 py-2.5 inline-flex items-center gap-2">
            <AudioPlayPill url={msg.previewUrl} />
            <div className="text-white/50 text-xs">{formatDurationMs(msg.durationMs)}</div>
          </div>
        </div>
      </div>
    )
  }

  const isAssistant = msg.role === 'assistant'
  const attachments = !isAssistant && msg.kind === 'text' ? msg.attachments ?? [] : []

  return (
    <div className={`flex mb-3 ${isAssistant ? 'justify-start' : 'justify-end'}`}>
      <div className={`max-w-[80%] ${isAssistant ? '' : 'items-end'}`}>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1 justify-end">
            {attachments.map((a) => <MessageAttachment key={a.id} attachment={a} />)}
          </div>
        )}
        <div
          className={`rounded-2xl px-3.5 py-2.5 ${
            isAssistant
              ? msg.error
                ? 'bg-red-500/10 text-red-300 rounded-bl-md'
                : 'bg-white/8 text-white/90 rounded-bl-md'
              : 'bg-orange-500/20 text-white rounded-br-md'
          }`}
        >
          {msg.text && <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.text}</div>}
          {isAssistant && msg.interrupted && (
            <div className="text-xs text-white/30 mt-1">[已中断]</div>
          )}
        </div>
        {isAssistant && !msg.error && !isStreaming && (
          <div className="flex items-center gap-1.5 mt-1.5 ml-1">
            <CopyButton text={msg.text} />
            {audioUrl && (
              <button
                type="button"
                onClick={() => {
                  const a = audioRef.current
                  if (!a) return
                  if (audioPlaying) { a.pause(); return }
                  try { a.currentTime = 0 } catch { /* ignore */ }
                  void a.play().catch(() => setAudioPlaying(false))
                }}
                className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
                  audioPlaying ? 'bg-orange-500/20 text-orange-300' : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70'
                }`}
                title={audioPlaying ? '停止播放' : '朗读'}
              >
                {audioPlaying ? <IconPause className="w-3.5 h-3.5" /> : <IconSpeaker className="w-3.5 h-3.5" />}
              </button>
            )}
            {isLastAssistant && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70 transition-colors"
                title="重新生成"
              >
                <IconRefresh className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Pending Reply ──────────────────────────────────────

function PendingReply({ text }: { text: string }) {
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%] bg-white/8 text-white/90 rounded-2xl rounded-bl-md px-3.5 py-2.5">
        <span className="text-sm whitespace-pre-wrap break-words">{text}</span>
        {!text && (
          <span className="inline-flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: '0s' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: '0.15s' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: '0.3s' }} />
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Settings Sheet ─────────────────────────────────────

function SettingsSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const backendHost = useCompanionStore((s) => s.backendHost)
  const systemPrompt = useCompanionStore((s) => s.miniSystemPromptTurnbased)
  const maxNewTokens = useCompanionStore((s) => s.miniMaxNewTokens)
  const lengthPenalty = useCompanionStore((s) => s.miniLengthPenalty)
  const ttsEnabled = useCompanionStore((s) => s.miniTtsEnabled)
  const streamingEnabled = useCompanionStore((s) => s.miniStreamingEnabled)
  const presets = useCompanionStore((s) => s.miniPresetsByMode)
  const activePresetId = useCompanionStore((s) => s.miniSettingsSheetMode)

  const setBackendHost = useCompanionStore((s) => s.setBackendHost)
  const setMiniSystemPromptTurnbased = useCompanionStore((s) => s.setMiniSystemPromptTurnbased)
  const setMiniMaxNewTokens = useCompanionStore((s) => s.setMiniMaxNewTokens)
  const setMiniLengthPenalty = useCompanionStore((s) => s.setMiniLengthPenalty)
  const setMiniTtsEnabled = useCompanionStore((s) => s.setMiniTtsEnabled)
  const setMiniStreamingEnabled = useCompanionStore((s) => s.setMiniStreamingEnabled)
  const setMiniSettingsSheetMode = useCompanionStore((s) => s.setMiniSettingsSheetMode)
  const setMiniSystemPrompt = useCompanionStore((s) => s.setMiniSystemPromptTurnbased)

  if (!open) return null

  const currentPresets = presets.turnbased ?? []
  const modes: Array<{ key: string; label: string }> = [
    { key: 'turnbased', label: '文字对话' },
    { key: 'audio_duplex', label: '语音通话' },
    { key: 'omni', label: '视频通话' },
  ]

  return (
    <div className="absolute inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-lg max-h-[80vh] bg-[#1c1c1c] border border-white/10 rounded-t-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#1c1c1c] px-5 pt-4 pb-3 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-white/90 text-base font-semibold">设置</h2>
          <button type="button" onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/50">
            <IconClose className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Mode selector */}
          <div className="flex gap-2">
            {modes.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMiniSettingsSheetMode(m.key as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activePresetId === m.key ? 'bg-orange-500/20 text-orange-300 border border-orange-400/30' : 'bg-white/5 text-white/50 hover:bg-white/10'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Backend host */}
          <div>
            <label className="text-white/50 text-xs block mb-1.5">后端地址</label>
            <input
              type="text"
              value={backendHost}
              onChange={(e) => setBackendHost(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-orange-400/40"
              placeholder="http://localhost:8006"
            />
          </div>

          {/* Presets */}
          <div>
            <label className="text-white/50 text-xs block mb-1.5">预设</label>
            <div className="flex flex-wrap gap-1.5">
              {currentPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="px-2.5 py-1 rounded-lg text-xs bg-white/5 text-white/60 hover:bg-white/10 transition-colors"
                  onClick={() => {
                    if (p.system_prompt) setMiniSystemPrompt(p.system_prompt)
                  }}
                >
                  {p.name}
                </button>
              ))}
              {currentPresets.length === 0 && (
                <span className="text-xs text-white/30">未获取到预设</span>
              )}
            </div>
          </div>

          {/* System prompt */}
          <div>
            <label className="text-white/50 text-xs block mb-1.5" htmlFor="sys-prompt">系统提示词</label>
            <textarea
              id="sys-prompt"
              value={systemPrompt}
              onChange={(e) => setMiniSystemPromptTurnbased(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-orange-400/40 resize-none"
              rows={4}
              placeholder="输入系统提示词..."
            />
          </div>

          {/* Params */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-white/50 text-xs block mb-1">最大 Token</label>
              <input
                type="number"
                value={maxNewTokens}
                onChange={(e) => setMiniMaxNewTokens(Number(e.target.value))}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-orange-400/40"
                min={1}
                max={2048}
              />
            </div>
            <div>
              <label className="text-white/50 text-xs block mb-1">长度惩罚</label>
              <input
                type="number"
                value={lengthPenalty}
                onChange={(e) => setMiniLengthPenalty(Number(e.target.value))}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-orange-400/40"
                min={0.1}
                max={5}
                step={0.05}
              />
            </div>
          </div>

          {/* Toggles */}
          <div className="space-y-3">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" checked={ttsEnabled} onChange={(e) => setMiniTtsEnabled(e.target.checked)} className="accent-orange-500" />
              <span className="text-sm text-white/70">语音回复 (TTS)</span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" checked={streamingEnabled} onChange={(e) => setMiniStreamingEnabled(e.target.checked)} className="accent-orange-500" />
              <span className="text-sm text-white/70">流式输出</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── History Drawer ─────────────────────────────────────

function HistoryDrawer({
  open,
  onClose,
  onSwitch,
  onDelete,
  onNewSession,
  onClearAll,
}: {
  open: boolean
  onClose: () => void
  onSwitch: (id: string) => void
  onDelete: (id: string) => void
  onNewSession: () => void
  onClearAll: () => void
}) {
  const sessions = useCompanionStore((s) => s.miniSessions)
  const activeId = useCompanionStore((s) => s.miniActiveSessionId)

  if (!open) return null

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="absolute inset-0 z-50 flex" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <aside
        className="relative w-72 max-w-[80vw] h-full bg-[#1c1c1c] border-r border-white/10 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-white/10">
          <button
            type="button"
            onClick={onNewSession}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/15 text-orange-300 hover:bg-orange-500/25 transition-colors text-sm font-medium"
          >
            <IconEdit className="w-4 h-4" />
            <span>新建对话</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sorted.length === 0 ? (
            <div className="text-center text-white/20 text-sm py-8">暂无历史记录</div>
          ) : (
            sorted.map((s) => (
              <div
                key={s.id}
                className={`flex items-center rounded-lg transition-colors ${
                  s.id === activeId ? 'bg-white/8' : 'hover:bg-white/5'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSwitch(s.id)}
                  className="flex-1 text-left px-3 py-2.5 min-w-0"
                >
                  <div className="text-sm text-white/80 truncate">{s.title}</div>
                  <div className="text-xs text-white/30 mt-0.5">{formatRelativeTime(s.updatedAt)}</div>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); if (confirm(`删除「${s.title}」?`)) onDelete(s.id) }}
                  className="w-8 h-8 flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-white/5 rounded-lg mr-1 transition-colors"
                >
                  <IconTrash className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="p-3 border-t border-white/10">
          <button
            type="button"
            onClick={() => { if (confirm('确定清除所有对话？')) onClearAll() }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-300 transition-colors text-xs"
          >
            <IconTrash className="w-3.5 h-3.5" />
            <span>清除所有数据</span>
          </button>
        </div>
      </aside>
    </div>
  )
}

// ─── Recording Overlay ──────────────────────────────────

function RecordingOverlay({ willCancel }: { willCancel: boolean }) {
  return (
    <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center">
      <div className={`px-8 py-4 rounded-2xl backdrop-blur-xl border transition-colors ${
        willCancel
          ? 'bg-red-500/20 border-red-400/30 text-red-300'
          : 'bg-orange-500/10 border-orange-400/20 text-orange-200'
      }`}>
        <div className="text-sm font-medium text-center">
          {willCancel ? '松开关闭' : '上滑取消'}
        </div>
        <div className="flex items-center justify-center gap-1 mt-2">
          {Array.from({ length: 28 }).map((_, i) => (
            <span
              key={i}
              className="w-0.5 bg-current rounded-full animate-pulse"
              style={{
                height: `${6 + Math.sin(i * 0.5 + Date.now() * 0.003) * 8}px`,
                animationDelay: `${(i % 14) * 60}ms`,
                opacity: willCancel ? 0.4 : 0.6,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main Companion Page ────────────────────────────────

export function Companion() {
  // ─── Store state ────────────────────────────────────────
  const messages = useCompanionStore((s) => s.miniMessages)
  const isGenerating = useCompanionStore((s) => s.miniIsGenerating)
  const pendingText = useCompanionStore((s) => s.miniPendingText)
  const serviceStatus = useCompanionStore((s) => s.miniServiceStatus)
  const backendHost = useCompanionStore((s) => s.backendHost)
  const scenario = useCompanionStore((s) => s.scenario)
  const settingsOpen = useCompanionStore((s) => s.miniSettingsOpen)
  const historyOpen = useCompanionStore((s) => s.miniHistoryOpen)
  const composeMode = useCompanionStore((s) => s.miniComposeMode)
  const draft = useCompanionStore((s) => s.miniDraft)
  const pendingAttachments = useCompanionStore((s) => s.miniPendingAttachments)
  const attachMenuOpen = useCompanionStore((s) => s.miniAttachMenuOpen)
  const isRecording = useCompanionStore((s) => s.miniRecording)
  const isPreparingRecording = useCompanionStore((s) => s.miniPreparingRecording)
  const recordingWillCancel = useCompanionStore((s) => s.miniRecordingWillCancel)
  const error = useCompanionStore((s) => s.miniError)

  const setMiniMessages = useCompanionStore((s) => s.setMiniMessages)
  const setMiniIsGenerating = useCompanionStore((s) => s.setMiniIsGenerating)
  const setMiniPendingText = useCompanionStore((s) => s.setMiniPendingText)
  const setMiniServiceStatus = useCompanionStore((s) => s.setMiniServiceStatus)
  const setMiniPresetsByMode = useCompanionStore((s) => s.setMiniPresetsByMode)
  const setMiniSettingsOpen = useCompanionStore((s) => s.setMiniSettingsOpen)
  const setMiniDraft = useCompanionStore((s) => s.setMiniDraft)
  const setMiniPendingAttachments = useCompanionStore((s) => s.setMiniPendingAttachments)
  const setMiniAttachMenuOpen = useCompanionStore((s) => s.setMiniAttachMenuOpen)
  const setMiniComposeMode = useCompanionStore((s) => s.setMiniComposeMode)
  const setMiniRecording = useCompanionStore((s) => s.setMiniRecording)
  const setMiniPreparingRecording = useCompanionStore((s) => s.setMiniPreparingRecording)
  const setMiniRecordingWillCancel = useCompanionStore((s) => s.setMiniRecordingWillCancel)
  const setMiniHistoryOpen = useCompanionStore((s) => s.setMiniHistoryOpen)
  const setMiniError = useCompanionStore((s) => s.setMiniError)
  const setMiniSessions = useCompanionStore((s) => s.setMiniSessions)
  const setMiniActiveSessionId = useCompanionStore((s) => s.setMiniActiveSessionId)
  const removeMiniPendingAttachment = useCompanionStore((s) => s.removeMiniPendingAttachment)
  const addMiniPendingAttachments = useCompanionStore((s) => s.addMiniPendingAttachments)

  const systemPrompt = useCompanionStore((s) => s.miniSystemPromptTurnbased)
  const maxNewTokens = useCompanionStore((s) => s.miniMaxNewTokens)
  const lengthPenalty = useCompanionStore((s) => s.miniLengthPenalty)
  const ttsEnabled = useCompanionStore((s) => s.miniTtsEnabled)
  const streamingEnabled = useCompanionStore((s) => s.miniStreamingEnabled)

  // ─── Refs ───────────────────────────────────────────────
  const threadWrapRef = useRef<HTMLDivElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const textInputRef = useRef<HTMLTextAreaElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const albumInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const captureStateRef = useRef(createMicCapture())
  const recordingStartRef = useRef(0)
  const recordingActionRef = useRef<'send' | 'cancel'>('send')
  const recordingPointerIdRef = useRef<number | null>(null)
  const recordingPointerStartYRef = useRef<number | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const playerRef = useRef<StreamingPcmPlayer | null>(null)
  const isStreamAudioPlayingRef = useRef(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // ─── Helpers ───────────────────────────────────────────

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const wrap = threadWrapRef.current
    if (wrap) wrap.scrollTo({ top: wrap.scrollHeight, behavior })
  }, [])

  const autoGrowTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [])

  // ─── Service status polling ──────────────────────────

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const status = await fetchServiceStatus(backendHost)
      if (!cancelled) setMiniServiceStatus(status)
    }
    void poll()
    const interval = setInterval(poll, 15000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [backendHost, setMiniServiceStatus])

  // ─── Presets loading ─────────────────────────────────

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const presets = await fetchPresets(backendHost)
      if (!cancelled) setMiniPresetsByMode(presets)
    })()
    return () => { cancelled = true }
  }, [backendHost, setMiniPresetsByMode])

  // ─── Scroll to bottom on new messages ────────────────

  useEffect(() => {
    scrollToBottom(isGenerating ? 'smooth' : 'auto')
  }, [messages.length, pendingText, scrollToBottom])

  // ─── Update sessions when messages change ────────────

  useEffect(() => {
    const activeSessionId = useCompanionStore.getState().miniActiveSessionId
    if (messages.length === 0) return
    setMiniSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === activeSessionId)
      const title = deriveSessionTitle(messages)
      const now = Date.now()
      if (idx === -1) {
        const created: MiniCPMoSession = { id: activeSessionId, title, createdAt: now, updatedAt: now, messages }
        return [...prev, created]
      }
      const next = [...prev]
      next[idx] = { ...next[idx]!, title, messages, updatedAt: now }
      return next
    })
  }, [messages])

  // ─── Build system prompt with scenario ───────────────

  const buildSystemMessage = useCallback((): string | null => {
    let prompt = systemPrompt.trim()
    if (scenario) {
      const sc = SCENARIOS.find((s) => s.id === scenario)
      if (sc) {
        prompt = `[场景: ${sc.name}]\n${sc.description || ''}\n\n${prompt}`
      }
    }
    return prompt || null
  }, [systemPrompt, scenario])

  // ─── Submit message ─────────────────────────────────

  const submitMessage = useCallback(async (nextMessages: MiniCPMoMessage[]) => {
    const systemMessage = buildSystemMessage()

    setMiniMessages(nextMessages)
    setMiniIsGenerating(true)

    if (streamingEnabled) {
      const player = ttsEnabled ? new StreamingPcmPlayer(24000) : undefined
      playerRef.current = player ?? null

      const { abort } = submitChatStreaming(backendHost, nextMessages, systemMessage, maxNewTokens, lengthPenalty, ttsEnabled, {
        onChunk: (text) => { setMiniPendingText(text) },
        onAudioBase64: (data) => { player?.pushBase64(data) },
        onDone: (text, sessionId) => {
          const entry: MiniCPMoMessage = {
            id: createId('assistant'),
            role: 'assistant',
            kind: 'assistant',
            text,
            audioPreviewUrl: null,
            recordingSessionId: sessionId,
          }
          // flush player audio
          if (player) {
            const merged = player.getMergedFloat32()
            if (merged && merged.length > 0) {
              entry.audioPreviewUrl = float32ToWavBlobUrl(merged, player.getSampleRate())
            }
            player.markFinished()
            player.disposeAfterDrain(() => { isStreamAudioPlayingRef.current = false })
          }
          const current = useCompanionStore.getState().miniMessages
          setMiniMessages([...current, entry])
          setMiniIsGenerating(false)
          setMiniPendingText('')
          if (sessionId) useCompanionStore.getState().setMiniLastSessionId(sessionId)
        },
        onError: (err) => {
          const current = useCompanionStore.getState().miniMessages
          setMiniMessages([...current, { id: createId('assistant'), role: 'assistant', kind: 'assistant', text: `错误: ${err}`, error: true }])
          setMiniIsGenerating(false)
          setMiniPendingText('')
        },
      }, player)
      abortRef.current = abort
    } else {
      try {
        const { entry, sessionId } = await submitChatNonStreaming(backendHost, nextMessages, systemMessage, maxNewTokens, lengthPenalty, ttsEnabled)
        setMiniMessages([...useCompanionStore.getState().miniMessages, entry])
        if (sessionId) useCompanionStore.getState().setMiniLastSessionId(sessionId)
      } catch (err) {
        setMiniMessages([...useCompanionStore.getState().miniMessages, {
          id: createId('assistant'), role: 'assistant', kind: 'assistant', text: `请求失败: ${err instanceof Error ? err.message : '未知错误'}`, error: true,
        }])
      }
      setMiniIsGenerating(false)
    }
  }, [backendHost, buildSystemMessage, maxNewTokens, lengthPenalty, ttsEnabled, streamingEnabled, setMiniMessages, setMiniIsGenerating, setMiniPendingText])

  // ─── Send text message ──────────────────────────────

  const sendTextMessage = useCallback(() => {
    const text = draft.trim()
    const atts = pendingAttachments
    if ((!text && atts.length === 0) || isGenerating || isPreparingRecording) return

    setMiniDraft('')
    setMiniPendingAttachments([])
    setMiniError(null)

    const nextMessages: MiniCPMoMessage[] = [
      ...messagesRef.current,
      { id: createId('user'), role: 'user', kind: 'text', text, attachments: atts.length > 0 ? atts : undefined },
    ]
    void submitMessage(nextMessages)
  }, [draft, pendingAttachments, isGenerating, isPreparingRecording, setMiniDraft, setMiniPendingAttachments, submitMessage])

  // ─── Regenerate ─────────────────────────────────────

  const regenerateLastReply = useCallback(() => {
    if (isGenerating || isPreparingRecording) return
    const current = messagesRef.current
    let lastUserIndex = -1
    for (let i = current.length - 1; i >= 0; i--) {
      if (current[i]!.role === 'user') { lastUserIndex = i; break }
    }
    if (lastUserIndex < 0) return
    const trimmed = current.slice(0, lastUserIndex + 1)
    setMiniMessages(trimmed)
    setMiniError(null)
    void submitMessage(trimmed)
  }, [isGenerating, isPreparingRecording, setMiniMessages, submitMessage])

  // ─── Session management ─────────────────────────────

  const startNewSession = useCallback(() => {
    const newId = createId('session')
    abortRef.current?.()
    setMiniActiveSessionId(newId)
    setMiniMessages([])
    setMiniDraft('')
    setMiniPendingAttachments([])
    setMiniHistoryOpen(false)
    setMiniError(null)
  }, [setMiniActiveSessionId, setMiniMessages, setMiniDraft, setMiniPendingAttachments, setMiniHistoryOpen])

  const switchToSession = useCallback((id: string) => {
    if (id === useCompanionStore.getState().miniActiveSessionId) { setMiniHistoryOpen(false); return }
    const sessions = useCompanionStore.getState().miniSessions
    const target = sessions.find((s) => s.id === id)
    if (!target) return
    abortRef.current?.()
    setMiniActiveSessionId(id)
    setMiniMessages(target.messages)
    setMiniDraft('')
    setMiniPendingAttachments([])
    setMiniHistoryOpen(false)
    setMiniError(null)
  }, [setMiniActiveSessionId, setMiniMessages, setMiniDraft, setMiniPendingAttachments, setMiniHistoryOpen])

  const deleteSession = useCallback((id: string) => {
    setMiniSessions((prev) => prev.filter((s) => s.id !== id))
    if (id === useCompanionStore.getState().miniActiveSessionId) {
      const remaining = useCompanionStore.getState().miniSessions.filter((s) => s.id !== id)
      if (remaining.length > 0) {
        switchToSession(remaining[0]!.id)
      } else {
        startNewSession()
      }
    }
  }, [setMiniSessions])

  const clearAllData = useCallback(() => {
    setMiniSessions([])
    startNewSession()
  }, [setMiniSessions, startNewSession])

  // ─── Attachments ─────────────────────────────────────

  const handleAttachFiles = useCallback(async (files: FileList | null, kind: 'image' | 'audio' | 'video') => {
    if (!files || files.length === 0) return
    const built: MiniCPMoAttachment[] = []
    for (const f of Array.from(files)) {
      try {
        const att = kind === 'image' ? await downscaleImageToAttachment(f) : await mediaFileToAttachment(f, kind)
        built.push(att as MiniCPMoAttachment)
      } catch { /* skip */ }
    }
    if (built.length > 0) {
      addMiniPendingAttachments(built)
      setMiniAttachMenuOpen(false)
    }
  }, [addMiniPendingAttachments, setMiniAttachMenuOpen])

  const handleCameraCapture = useCallback(async (files: FileList | null) => {
    if (!files || !files[0]) return
    try {
      const att = await downscaleImageToAttachment(files[0])
      addMiniPendingAttachments([att as MiniCPMoAttachment])
      setMiniAttachMenuOpen(false)
    } catch { /* ignore */ }
  }, [addMiniPendingAttachments, setMiniAttachMenuOpen])

  // ─── Recording ──────────────────────────────────────

  const beginRecordingCapture = useCallback(async (initiatingPointerId: number) => {
    const state = captureStateRef.current
    const stillHolding = () => recordingPointerIdRef.current === initiatingPointerId

    let warm = state.ctx !== null && state.stream !== null
    if (!warm) warm = await prewarmMic(state, backendHost)
    if (!stillHolding()) return
    if (!warm || !state.ctx || !state.stream) {
      setMiniError('麦克风初始化失败')
      coldDownMic(state)
      return
    }
    if (state.ctx.state === 'suspended') await state.ctx.resume().catch(() => {})
    if (!stillHolding()) return
    if (state.ctx.state !== 'running') {
      setMiniError('音频通道不可用')
      coldDownMic(state)
      return
    }
    setCapturing(state, true)
  }, [setMiniError])

  const finalizeRecording = useCallback(async () => {
    const state = captureStateRef.current
    setCapturing(state, false)
    recordingPointerIdRef.current = null

    const result = finalizeRecordingChunks(state)
    if (!result) return

    const carriedAttachments = pendingAttachments
    if (carriedAttachments.length > 0) setMiniPendingAttachments([])

    const nextMessages: MiniCPMoMessage[] = [
      ...messagesRef.current,
      {
        id: createId('voice'),
        role: 'user',
        kind: 'voice',
        audioBase64: result.audioBase64,
        durationMs: performance.now() - recordingStartRef.current,
        previewUrl: result.previewUrl,
        attachments: carriedAttachments.length > 0 ? carriedAttachments : undefined,
      },
    ]
    setMiniRecording(false)
    setMiniPreparingRecording(false)
    void submitMessage(nextMessages)
  }, [pendingAttachments, setMiniPendingAttachments, setMiniRecording, setMiniPreparingRecording, submitMessage])

  const handleTalkPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (isRecording || isPreparingRecording) return
    recordingPointerStartYRef.current = event.clientY
    recordingPointerIdRef.current = event.pointerId
    recordingActionRef.current = 'send'
    captureStateRef.current.chunks = []
    recordingStartRef.current = performance.now()
    setMiniRecording(true)
    setMiniError(null)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
    void beginRecordingCapture(event.pointerId)
  }, [isRecording, isPreparingRecording, setMiniRecording, beginRecordingCapture])

  const handleTalkPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (recordingPointerIdRef.current !== event.pointerId) return
    const startY = recordingPointerStartYRef.current
    if (startY === null) return
    setMiniRecordingWillCancel(startY - event.clientY > CANCEL_DRAG_PX)
  }, [setMiniRecordingWillCancel])

  const handleTalkPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (recordingPointerIdRef.current !== event.pointerId && recordingPointerIdRef.current !== null) return
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* ignore */ }

    if (!isRecording) {
      recordingPointerIdRef.current = null
      return
    }

    if (recordingWillCancel) {
      coldDownMic(captureStateRef.current)
      setMiniRecording(false)
      setMiniPreparingRecording(false)
      recordingPointerIdRef.current = null
      return
    }

    void finalizeRecording()
  }, [isRecording, recordingWillCancel, finalizeRecording, setMiniRecording, setMiniPreparingRecording])

  const handleTalkPointerCancel = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (recordingPointerIdRef.current !== event.pointerId && recordingPointerIdRef.current !== null) return
    coldDownMic(captureStateRef.current)
    setMiniRecording(false)
    setMiniPreparingRecording(false)
    recordingPointerIdRef.current = null
  }, [setMiniRecording, setMiniPreparingRecording])

  // ─── Attach menu drawing ───────────────────────────

  const attachItems = [
    { icon: IconCamera, label: '拍照', onClick: () => cameraInputRef.current?.click() },
    { icon: IconPhoto, label: '相册', onClick: () => albumInputRef.current?.click() },
    { icon: IconFile, label: '文件', onClick: () => fileInputRef.current?.click() },
  ]

  // ─── Render ──────────────────────────────────────────

  const currentScenario = scenario ? SCENARIOS.find((s) => s.id === scenario) : null

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#131313] flex flex-col">
      {/* Hidden file inputs */}
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { void handleCameraCapture(e.target.files); e.target.value = '' }} />
      <input ref={albumInputRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { void handleAttachFiles(e.target.files, 'image'); e.target.value = '' }} />
      <input ref={fileInputRef} type="file" accept="image/*,audio/*,video/*" multiple hidden
        onChange={(e) => { void handleAttachFiles(e.target.files, 'image'); e.target.value = '' }} />

      {/* ─── Top Bar ────────────────────────────────────── */}
      <header className="flex items-center gap-2 px-3 py-2.5 border-b border-white/5 shrink-0">
        <button
          type="button"
          onClick={() => setMiniHistoryOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-white/5 text-white/50 hover:text-white/80 transition-colors"
        >
          <IconHamburger className="w-5 h-5" />
        </button>

        <div className="flex-1 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => useCompanionStore.getState().setScenarioPanelOpen(true)}
            className="flex items-center gap-1.5 px-3 h-7 rounded-full bg-white/5 border border-white/8 hover:bg-white/10 transition-all text-white/60 hover:text-white/80"
          >
            {currentScenario ? (
              <>
                <span className="material-symbols-outlined text-sm">{currentScenario.icon}</span>
                <span className="text-xs font-medium">{currentScenario.name}</span>
              </>
            ) : (
              <span className="text-xs font-medium">选择场景</span>
            )}
            <span className="material-symbols-outlined text-xs text-white/20">expand_more</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          {/* Status dot */}
          <span className={`w-1.5 h-1.5 rounded-full ${
            serviceStatus.phase === 'ready' ? 'bg-green-500' :
            serviceStatus.phase === 'error' ? 'bg-red-500' : 'bg-yellow-500 animate-pulse'
          }`} title={serviceStatus.detail} />
          <button
            type="button"
            onClick={() => setMiniSettingsOpen(true)}
            className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-white/5 text-white/50 hover:text-white/80 transition-colors"
          >
            <IconSettings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* ─── Messages Thread ───────────────────────────── */}
      <div ref={threadWrapRef} className="flex-1 overflow-y-auto px-4 py-3">
        <div ref={threadEndRef} />
        {messages.length === 0 && !isGenerating && (
          <div className="flex flex-col items-center justify-center h-full text-white/15">
            <span className="material-symbols-outlined text-5xl mb-3">chat</span>
            <p className="text-sm">开始一段新对话</p>
            <p className="text-xs mt-1">点击下方按钮发送消息或录音</p>
          </div>
        )}
        {messages.map((msg, idx) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            isLastAssistant={msg.role === 'assistant' && idx === messages.length - 1}
            isStreaming={isGenerating && idx === messages.length - 1}
            onRegenerate={regenerateLastReply}
          />
        ))}
        {isGenerating && <PendingReply text={pendingText} />}
        <div />
      </div>

      {/* ─── Error ──────────────────────────────────────── */}
      {error && (
        <div className="px-4 py-2 mx-3 mb-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs text-center">
          {error}
        </div>
      )}

      {/* ─── Pending Attachments Strip ─────────────────── */}
      {pendingAttachments.length > 0 && (
        <div className="flex gap-1.5 px-4 py-1.5 overflow-x-auto shrink-0">
          {pendingAttachments.map((a) => (
            <div key={a.id} className="relative shrink-0">
              {a.kind === 'image' ? (
                <img src={a.previewUrl} alt="" className="w-12 h-12 rounded-lg object-cover" />
              ) : (
                <div className="w-12 h-12 rounded-lg bg-white/8 flex items-center justify-center text-white/40">
                  <span className="material-symbols-outlined text-lg">
                    {a.kind === 'audio' ? 'music_note' : 'movie'}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeMiniPendingAttachment(a.id)}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 text-white flex items-center justify-center text-xs hover:bg-red-500"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ─── Composer ──────────────────────────────────── */}
      <div className="shrink-0 px-3 pb-3 pt-1">
        <div className={`flex items-center gap-1.5 bg-white/5 border border-white/8 rounded-2xl px-2 py-1.5 transition-all ${
          isGenerating ? 'border-orange-400/30' : ''
        }`}>
          {/* Camera button */}
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={isGenerating || isPreparingRecording}
            className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-white/5 text-white/40 hover:text-white/70 disabled:opacity-30 transition-colors"
          >
            <IconCamera className="w-5 h-5" />
          </button>

          {/* Main input area */}
          {composeMode === 'text' ? (
            <form
              onSubmit={(e) => { e.preventDefault(); sendTextMessage() }}
              className="flex-1 flex items-center"
            >
              <textarea
                ref={textInputRef}
                value={draft}
                onChange={(e) => { setMiniDraft(e.target.value); autoGrowTextarea(e.target) }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage() } }}
                placeholder="输入消息..."
                rows={1}
                disabled={isGenerating || isPreparingRecording}
                className="flex-1 bg-transparent text-sm text-white/80 placeholder-white/20 outline-none resize-none max-h-[140px] px-1 py-1.5"
              />
              {draft.trim() || pendingAttachments.length > 0 ? (
                <button
                  type="submit"
                  disabled={isGenerating}
                  className="w-9 h-9 flex items-center justify-center rounded-xl bg-orange-500/20 text-orange-300 hover:bg-orange-500/30 transition-colors disabled:opacity-30"
                >
                  <IconSend className="w-4.5 h-4.5" />
                </button>
              ) : null}
            </form>
          ) : (
            <button
              type="button"
              onPointerDown={handleTalkPointerDown}
              onPointerMove={handleTalkPointerMove}
              onPointerUp={handleTalkPointerUp}
              onPointerCancel={handleTalkPointerCancel}
              disabled={isGenerating}
              className={`flex-1 h-9 flex items-center justify-center rounded-xl transition-all ${
                isRecording
                  ? 'bg-orange-500/20 text-orange-300'
                  : isGenerating
                  ? 'bg-white/5 text-white/30'
                  : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70'
              } disabled:opacity-40`}
            >
              <span className="text-xs font-medium">
                {isRecording ? '录音中...' : isGenerating ? '等待回复...' : '按住说话'}
              </span>
            </button>
          )}

          {/* Mode switch: keyboard <-> voice */}
          <button
            type="button"
            onClick={() => {
              setMiniComposeMode(composeMode === 'voice' ? 'text' : 'voice')
              if (composeMode === 'voice') {
                setTimeout(() => textInputRef.current?.focus(), 100)
              }
            }}
            disabled={isGenerating || isPreparingRecording}
            className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-white/5 text-white/40 hover:text-white/70 disabled:opacity-30 transition-colors"
          >
            {composeMode === 'voice' ? <IconKeyboard className="w-5 h-5" /> : <IconWave className="w-5 h-5" />}
          </button>

          {/* Attach button */}
          <button
            type="button"
            onClick={() => setMiniAttachMenuOpen(!attachMenuOpen)}
            disabled={isGenerating || isPreparingRecording}
            className={`w-9 h-9 flex items-center justify-center rounded-xl transition-colors ${
              attachMenuOpen ? 'bg-orange-500/15 text-orange-300' : 'hover:bg-white/5 text-white/40 hover:text-white/70'
            } disabled:opacity-30`}
          >
            {attachMenuOpen ? <IconClose className="w-5 h-5" /> : <IconPlus className="w-5 h-5" />}
          </button>

          {/* Send / Stop button */}
          {isGenerating || (composeMode === 'text' && draft.trim()) || pendingAttachments.length > 0 ? (
            composeMode === 'voice' && !isGenerating && !draft.trim() && pendingAttachments.length === 0 ? null : (
              <button
                type="button"
                onClick={() => {
                  if (isGenerating) {
                    abortRef.current?.()
                    setMiniIsGenerating(false)
                    setMiniPendingText('')
                    return
                  }
                  sendTextMessage()
                }}
                className={`w-9 h-9 flex items-center justify-center rounded-xl transition-colors ${
                  isGenerating
                    ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                    : 'bg-orange-500/20 text-orange-300 hover:bg-orange-500/30'
                }`}
              >
                {isGenerating ? <IconStop className="w-4.5 h-4.5" /> : <IconSend className="w-4.5 h-4.5" />}
              </button>
            )
          ) : null}
        </div>

        {/* Attach menu drawer */}
        {attachMenuOpen && (
          <div className="flex items-center gap-2 mt-2 px-1">
            {attachItems.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.onClick}
                className="flex flex-col items-center gap-1 px-3 py-2 rounded-xl hover:bg-white/5 transition-colors"
              >
                <item.icon className="w-6 h-6 text-white/40" />
                <span className="text-[10px] text-white/30">{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ─── Overlays ───────────────────────────────────── */}
      {isRecording && <RecordingOverlay willCancel={recordingWillCancel} />}
      <ScenarioSelector />
      <SettingsSheet open={settingsOpen} onClose={() => setMiniSettingsOpen(false)} />
      <HistoryDrawer
        open={historyOpen}
        onClose={() => setMiniHistoryOpen(false)}
        onSwitch={switchToSession}
        onDelete={deleteSession}
        onNewSession={startNewSession}
        onClearAll={clearAllData}
      />
    </div>
  )
}
