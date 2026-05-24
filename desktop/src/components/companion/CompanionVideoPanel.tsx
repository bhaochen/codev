import { useEffect, useRef } from 'react'
import { useTranslation } from '../../i18n'
import type { CompanionStatus } from '../../types/companion'

interface CompanionVideoPanelProps {
  webcamStream: MediaStream | null
  speaking: boolean
  generating: boolean
  status: CompanionStatus
}

export function CompanionVideoPanel({
  webcamStream,
  speaking,
  generating,
  status,
}: CompanionVideoPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const t = useTranslation()

  useEffect(() => {
    if (videoRef.current && webcamStream) {
      videoRef.current.srcObject = webcamStream
    }
  }, [webcamStream])

  const statusLabel = generating
    ? t('companion.speaking')
    : speaking
    ? t('companion.listening')
    : status === 'connected'
    ? t('companion.alwaysHere')
    : t('companion.status.disconnected')

  return (
    <div className="companion-video-panel absolute inset-0 overflow-hidden">
      {/* Background gradient */}
      <div
        className={`absolute inset-0 transition-all duration-700 ${
          generating
            ? 'bg-gradient-to-br from-indigo-950 via-purple-900 to-slate-950'
            : 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900'
        }`}
      />

      {/* AI Presence indicator */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-4">
        <div
          className={`w-32 h-32 rounded-full transition-all duration-500 flex items-center justify-center ${
            generating
              ? 'bg-purple-600/30 shadow-[0_0_60px_rgba(147,51,234,0.4)] animate-pulse'
              : speaking
              ? 'bg-blue-500/20 shadow-[0_0_30px_rgba(59,130,246,0.3)]'
              : 'bg-gray-600/10'
          }`}
        >
          <span className="material-symbols-outlined text-5xl text-white/60">
            {generating ? 'record_voice_over' : 'psychology'}
          </span>
        </div>
        <span className="text-white/40 text-sm font-medium">{statusLabel}</span>
      </div>

      {/* Webcam PiP overlay */}
      {webcamStream && (
        <div className="absolute bottom-6 right-6 w-[180px] h-[240px] rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover scale-x-[-1]"
          />
        </div>
      )}

      {/* Connection status badge */}
      <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm">
        <span
          className={`w-2 h-2 rounded-full ${
            status === 'connected'
              ? 'bg-green-500'
              : status === 'connecting'
              ? 'bg-yellow-500 animate-pulse'
              : status === 'error'
              ? 'bg-red-500'
              : 'bg-gray-500'
          }`}
        />
        <span className="text-white/60 text-xs">{status}</span>
      </div>
    </div>
  )
}
