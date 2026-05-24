import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from '../../i18n'
import { useCompanionStore } from '../../stores/companionStore'
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
  const avatarFileRef = useRef<HTMLInputElement>(null)
  const bgFileRef = useRef<HTMLInputElement>(null)
  const t = useTranslation()
  const avatarUrl = useCompanionStore((s) => s.avatarUrl)
  const backgroundUrl = useCompanionStore((s) => s.backgroundUrl)
  const setAvatarUrl = useCompanionStore((s) => s.setAvatarUrl)
  const setBackgroundUrl = useCompanionStore((s) => s.setBackgroundUrl)

  useEffect(() => {
    if (videoRef.current && webcamStream) {
      videoRef.current.srcObject = webcamStream
    }
  }, [webcamStream])

  const handleAvatarPick = useCallback(() => {
    avatarFileRef.current?.click()
  }, [])

  const handleBgPick = useCallback(() => {
    bgFileRef.current?.click()
  }, [])

  const handleAvatarFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => setAvatarUrl(reader.result as string)
      reader.readAsDataURL(file)
      // Reset so the same file can be re-selected
      e.target.value = ''
    },
    [setAvatarUrl],
  )

  const handleBgFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => setBackgroundUrl(reader.result as string)
      reader.readAsDataURL(file)
      e.target.value = ''
    },
    [setBackgroundUrl],
  )

  const statusLabel = generating
    ? t('companion.speaking')
    : speaking
    ? t('companion.listening')
    : status === 'connected'
    ? t('companion.alwaysHere')
    : t('companion.status.disconnected')

  return (
    <div className="companion-video-panel absolute inset-0 overflow-hidden">
      {/* Background */}
      {backgroundUrl ? (
        <div
          className="absolute inset-0 bg-cover bg-center transition-all duration-700"
          style={{ backgroundImage: `url(${backgroundUrl})` }}
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 transition-all duration-700" />
      )}

      {/* Background edit button */}
      <button
        type="button"
        onClick={handleBgPick}
        className="absolute top-4 left-4 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-black/30 backdrop-blur-sm text-white/50 hover:text-white/80 hover:bg-black/50 transition-all text-xs"
        title="Change background"
      >
        <span className="material-symbols-outlined text-sm">image</span>
        Background
      </button>
      <input
        ref={bgFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleBgFile}
      />

      {/* AI Presence indicator */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-4">
        <div className="relative group">
          <div
            className={`w-32 h-32 rounded-full transition-all duration-500 flex items-center justify-center overflow-hidden ${
              generating
                ? 'shadow-[0_0_60px_rgba(147,51,234,0.4)] animate-pulse ring-2 ring-purple-500/50'
                : speaking
                ? 'shadow-[0_0_30px_rgba(59,130,246,0.3)] ring-2 ring-blue-500/30'
                : ''
            }`}
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="avatar"
                className="w-full h-full object-cover"
              />
            ) : (
              <div
                className={`w-full h-full flex items-center justify-center ${
                  generating
                    ? 'bg-purple-600/30'
                    : speaking
                    ? 'bg-blue-500/20'
                    : 'bg-gray-600/10'
                }`}
              >
                <span className="material-symbols-outlined text-5xl text-white/60">
                  {generating ? 'record_voice_over' : 'psychology'}
                </span>
              </div>
            )}
          </div>
          {/* Avatar edit overlay */}
          <button
            type="button"
            onClick={handleAvatarPick}
            className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-purple-600/80 hover:bg-purple-600 flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 shadow-lg"
          >
            <span className="material-symbols-outlined text-sm text-white">edit</span>
          </button>
        </div>
        <span className="text-white/40 text-sm font-medium">{statusLabel}</span>
      </div>
      <input
        ref={avatarFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarFile}
      />

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
