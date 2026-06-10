import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from '../../i18n'
import { useCompanionStore } from '../../stores/companionStore'
import type { CompanionStatus } from '../../types/companion'

interface CompanionVideoPanelProps {
  webcamStream: MediaStream | null
  speaking: boolean
  generating: boolean
  status: CompanionStatus
  onFlipCamera?: () => void
}

export function CompanionVideoPanel({
  webcamStream,
  speaking,
  generating,
  status,
  onFlipCamera,
}: CompanionVideoPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const avatarFileRef = useRef<HTMLInputElement>(null)
  const t = useTranslation()
  const avatarUrl = useCompanionStore((s) => s.avatarUrl)
  const backgroundUrl = useCompanionStore((s) => s.backgroundUrl)
  const setAvatarUrl = useCompanionStore((s) => s.setAvatarUrl)
  const cameraFullscreen = useCompanionStore((s) => s.cameraFullscreen)
  const cameraEnabled = useCompanionStore((s) => s.cameraEnabled)
  const screenShareStream = useCompanionStore((s) => s.screenShareStream)
  const transcript = useCompanionStore((s) => s.transcript)
  const fullTranscript = useCompanionStore((s) => s.fullTranscript)
  const subtitleEnabled = useCompanionStore((s) => s.subtitleEnabled)

  useEffect(() => {
    if (videoRef.current && webcamStream) {
      videoRef.current.srcObject = webcamStream
    }
  }, [webcamStream])

  const handleAvatarPick = useCallback(() => {
    avatarFileRef.current?.click()
  }, [])

  const handleAvatarFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => setAvatarUrl(reader.result as string)
      reader.readAsDataURL(file)
      e.target.value = ''
    },
    [setAvatarUrl],
  )

  const isFullScreenCamera = cameraEnabled && cameraFullscreen && webcamStream
  // When subtitle is on AND there's transcript content, shrink the main view
  const hasTranscriptContent = subtitleEnabled && (!!transcript || !!fullTranscript)

  const statusLabel = generating
    ? t('companion.speaking')
    : speaking
    ? t('companion.listening')
    : status === 'connected'
    ? t('companion.alwaysHere')
    : t('companion.status.disconnected')

  return (
    <div className="companion-video-panel absolute inset-0 overflow-hidden">
      {/* Background - clean warm gradient */}
      {backgroundUrl ? (
        <div
          className="absolute inset-0 bg-cover bg-center transition-all duration-700"
          style={{ backgroundImage: `url(${backgroundUrl})` }}
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-orange-950/80 via-slate-950 to-amber-950/60 transition-all duration-700" />
      )}

      {/* Fullscreen camera view */}
      {isFullScreenCamera && (
        <div className="absolute inset-0 bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover scale-x-[-1]"
          />
          {/* Flip camera overlay */}
          <div className="absolute top-14 right-4 flex flex-col gap-2 z-20">
            <button
              type="button"
              onClick={onFlipCamera}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-md text-white/70 hover:text-white hover:bg-black/60 transition-all"
              title={t('companion.flipCamera')}
            >
              <span className="material-symbols-outlined text-xl">flip_camera_android</span>
            </button>
          </div>
        </div>
      )}

      {/* Screen share overlay */}
      {screenShareStream && !isFullScreenCamera && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
          <div className="text-center">
            <span className="material-symbols-outlined text-5xl text-orange-400/60 mb-3">present_to_all</span>
            <p className="text-white/50 text-sm">正在共享屏幕</p>
          </div>
        </div>
      )}

      {/* AI Avatar - large center (default), small top-left when subtitles active */}
      {!isFullScreenCamera && !screenShareStream && (
        <div
          className={`absolute flex flex-col items-center gap-3 transition-all duration-500 ${
            hasTranscriptContent
              ? 'top-6 left-6 scale-[0.45] origin-top-left'
              : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
          }`}
        >
          <div className="relative">
            <div
              className={`rounded-full transition-all duration-700 flex items-center justify-center overflow-hidden ${
                hasTranscriptContent ? 'w-24 h-24' : 'w-36 h-36'
              } ${
                generating
                  ? 'shadow-[0_0_60px_rgba(251,146,60,0.4)] ring-2 ring-orange-400/60'
                  : speaking
                  ? 'shadow-[0_0_40px_rgba(251,146,60,0.25)] ring-2 ring-orange-400/30'
                  : 'shadow-[0_0_15px_rgba(255,255,255,0.08)] ring-1 ring-white/10'
              }`}
              style={{
                background: generating
                  ? 'radial-gradient(circle, rgba(251,146,60,0.25) 0%, rgba(249,115,22,0.1) 100%)'
                  : speaking
                  ? 'radial-gradient(circle, rgba(251,146,60,0.15) 0%, rgba(249,115,22,0.05) 100%)'
                  : 'radial-gradient(circle, rgba(255,255,255,0.04) 0%, transparent 100%)',
              }}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {(speaking || generating) && (
                    <div className="absolute inset-0 rounded-full animate-ping opacity-10 bg-orange-400" />
                  )}
                  {/* Default female avatar silhouette */}
                  <div className="flex flex-col items-center justify-center text-white/50">
                    <span className="material-symbols-outlined text-5xl">face_6</span>
                  </div>
                </div>
              )}
            </div>
            {!hasTranscriptContent && (
              <button
                type="button"
                onClick={handleAvatarPick}
                className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-orange-500/70 hover:bg-orange-500 flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 shadow-lg z-10"
              >
                <span className="material-symbols-outlined text-xs text-white">edit</span>
              </button>
            )}
          </div>
          {!hasTranscriptContent && (
            <span className="text-white/40 text-xs font-medium tracking-wide">{statusLabel}</span>
          )}
        </div>
      )}
      <input
        ref={avatarFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarFile}
      />

      {/* Webcam PiP overlay */}
      {webcamStream && !isFullScreenCamera && (
        <div
          className={`absolute rounded-2xl overflow-hidden border-2 border-white/15 shadow-2xl bg-black z-10 transition-all duration-500 ${
            hasTranscriptContent
              ? 'top-4 right-4 w-[120px] h-[160px]'
              : 'bottom-6 right-6 w-[160px] h-[220px]'
          }`}
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover scale-x-[-1]"
          />
        </div>
      )}

      {/* Connection status badge - top right (moved left when webcam PiP shows) */}
      <div
        className={`absolute top-4 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm z-10 ${
          webcamStream && !isFullScreenCamera ? 'left-4' : 'right-4'
        }`}
      >
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
        <span className="text-white/50 text-xs">{status}</span>
      </div>
    </div>
  )
}
