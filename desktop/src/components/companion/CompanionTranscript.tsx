import { useRef, useEffect, useState, useCallback } from 'react'
import { useTranslation } from '../../i18n'

interface CompanionTranscriptProps {
  transcript: string
  fullTranscript: string
  generating: boolean
  onSendText: (text: string) => void
  disabled?: boolean
}

export function CompanionTranscript({ transcript, fullTranscript, generating, onSendText, disabled }: CompanionTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [inputValue, setInputValue] = useState('')
  const t = useTranslation()

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [transcript, fullTranscript])

  const handleSend = useCallback(() => {
    const text = inputValue.trim()
    if (!text) return
    onSendText(text)
    setInputValue('')
  }, [inputValue, onSendText])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  return (
    <div className="companion-transcript absolute bottom-20 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4">
      {/* Transcript display */}
      <div
        ref={scrollRef}
        className={`max-h-[150px] overflow-y-auto rounded-2xl bg-black/40 backdrop-blur-md border p-4 mb-2 scrollbar-thin transition-all duration-500 ${
          generating
            ? 'border-purple-500/50 shadow-[0_0_20px_rgba(147,51,234,0.2)]'
            : 'border-white/10'
        }`}
      >
        {fullTranscript && (
          <div className="text-white/40 text-xs mb-2 whitespace-pre-wrap leading-relaxed">
            {fullTranscript}
          </div>
        )}
        {transcript && (
          <div className="text-white/90 text-sm font-medium leading-relaxed">
            {transcript}
            <span className="inline-block w-1.5 h-4 ml-0.5 bg-purple-400 animate-pulse" />
          </div>
        )}
        {!transcript && !fullTranscript && (
          <div className="text-white/30 text-sm text-center py-2">
            {t('companion.transcriptPlaceholder')}
          </div>
        )}
      </div>

      {/* Text input row */}
      <div className={`flex items-center gap-2 rounded-2xl bg-black/40 backdrop-blur-md border px-4 py-2 transition-all duration-500 ${
          generating
            ? 'border-purple-500/50 shadow-[0_0_20px_rgba(147,51,234,0.2)]'
            : 'border-white/10'
        }`}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('companion.inputPlaceholder')}
          disabled={disabled}
          className="flex-1 bg-transparent text-sm text-white/90 placeholder-white/30 outline-none border-none disabled:opacity-40"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !inputValue.trim()}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600/40 text-purple-300 hover:bg-purple-600/60 transition-all disabled:opacity-30"
          title={t('companion.send')}
        >
          <span className="material-symbols-outlined text-lg">send</span>
        </button>
      </div>
    </div>
  )
}
