import { useRef, useEffect, useState, useCallback } from 'react'
import { useTranslation } from '../../i18n'
import { useCompanionStore } from '../../stores/companionStore'

interface CompanionTranscriptProps {
  transcript: string
  fullTranscript: string
  generating: boolean
  onSendText: (text: string) => void
  disabled?: boolean
}

export function CompanionTranscript({
  transcript,
  fullTranscript,
  generating,
  onSendText,
  disabled,
}: CompanionTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [inputValue, setInputValue] = useState('')
  const t = useTranslation()
  const subtitleEnabled = useCompanionStore((s) => s.subtitleEnabled)
  const hasContent = !!transcript || !!fullTranscript

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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  // When subtitles are on and there's content, show full-screen transcript
  if (subtitleEnabled && hasContent) {
    return (
      <div className="absolute inset-0 z-5 flex flex-col">
        {/* Scrollable transcript area - takes most of the screen */}
        <div className="flex-1 flex items-center justify-center px-8 py-20">
          <div
            ref={scrollRef}
            className="w-full max-w-2xl max-h-full overflow-y-auto scrollbar-thin"
          >
            {fullTranscript && (
              <div className="text-white/50 text-sm mb-3 whitespace-pre-wrap leading-relaxed text-center">
                {fullTranscript}
              </div>
            )}
            {transcript && (
              <div className="text-white/90 text-base font-medium leading-relaxed text-center">
                {transcript}
                <span className="inline-block w-1.5 h-4 ml-0.5 bg-orange-400 animate-pulse" />
              </div>
            )}
          </div>
        </div>

        {/* Text input at bottom */}
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 w-full max-w-md px-4">
          <div className="flex items-center gap-2 rounded-full bg-black/50 backdrop-blur-md border border-white/10 px-4 py-2">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('companion.inputPlaceholder')}
              disabled={disabled}
              className="flex-1 bg-transparent text-sm text-white/80 placeholder-white/30 outline-none border-none disabled:opacity-40"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled || !inputValue.trim()}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/40 text-orange-200 hover:bg-orange-500/60 transition-all disabled:opacity-30"
              title={t('companion.send')}
            >
              <span className="material-symbols-outlined text-sm">send</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Subtitles on but no content yet - show compact version
  if (subtitleEnabled && !hasContent) {
    return (
      <div className="companion-transcript absolute bottom-20 left-1/2 -translate-x-1/2 w-full max-w-md px-4">
        <div
          className={`flex items-center gap-2 rounded-full bg-black/40 backdrop-blur-md border border-white/10 px-4 py-2 transition-all duration-500 ${
            generating ? 'border-orange-400/40' : ''
          }`}
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('companion.inputPlaceholder')}
            disabled={disabled}
            className="flex-1 bg-transparent text-sm text-white/80 placeholder-white/30 outline-none border-none disabled:opacity-40"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled || !inputValue.trim()}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/40 text-orange-200 hover:bg-orange-500/60 transition-all disabled:opacity-30"
            title={t('companion.send')}
          >
            <span className="material-symbols-outlined text-sm">send</span>
          </button>
        </div>
      </div>
    )
  }

  // Subtitles off - show compact transcript bubble
  return (
    <div className="companion-transcript absolute bottom-20 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4">
      {hasContent && (
        <div
          ref={scrollRef}
          className={`max-h-[120px] overflow-y-auto rounded-2xl bg-black/40 backdrop-blur-md border p-3 mb-2 scrollbar-thin transition-all duration-500 ${
            generating
              ? 'border-orange-400/40'
              : 'border-white/10'
          }`}
        >
          {fullTranscript && !transcript && (
            <div className="text-white/40 text-xs whitespace-pre-wrap leading-relaxed">
              {fullTranscript}
            </div>
          )}
          {transcript && (
            <div className="text-white/80 text-sm font-medium leading-relaxed">
              {transcript}
              <span className="inline-block w-1.5 h-4 ml-0.5 bg-orange-400 animate-pulse" />
            </div>
          )}
        </div>
      )}

      {/* Text input */}
      <div
        className={`flex items-center gap-2 rounded-2xl bg-black/40 backdrop-blur-md border px-4 py-2 transition-all duration-500 ${
          generating ? 'border-orange-400/40' : 'border-white/10'
        }`}
      >
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('companion.inputPlaceholder')}
          disabled={disabled}
          className="flex-1 bg-transparent text-sm text-white/80 placeholder-white/30 outline-none border-none disabled:opacity-40"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !inputValue.trim()}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/40 text-orange-200 hover:bg-orange-500/60 transition-all disabled:opacity-30"
          title={t('companion.send')}
        >
          <span className="material-symbols-outlined text-lg">send</span>
        </button>
      </div>
    </div>
  )
}
