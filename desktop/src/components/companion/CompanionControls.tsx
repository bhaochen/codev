import { useCallback, useState } from 'react'
import { useTranslation } from '../../i18n'
import type { CompanionStatus } from '../../types/companion'

interface CompanionControlsProps {
  status: CompanionStatus
  micEnabled: boolean
  cameraEnabled: boolean
  generating: boolean
  isSharing: boolean
  onToggleMic: () => void
  onToggleCamera: () => void
  onScreenShareClick: () => void
  onConnect: () => void
  onDisconnect: () => void
  onStop: () => void
  onResumeAudio: () => void
}

export function CompanionControls({
  status,
  micEnabled,
  cameraEnabled,
  generating,
  isSharing,
  onToggleMic,
  onToggleCamera,
  onScreenShareClick,
  onConnect,
  onDisconnect,
  onStop,
  onResumeAudio,
}: CompanionControlsProps) {
  const t = useTranslation()
  const isConnected = status === 'connected'
  const [speakerOn, setSpeakerOn] = useState(true)

  const handleConnectClick = useCallback(() => {
    onConnect()
    onResumeAudio()
  }, [onConnect, onResumeAudio])

  return (
    <div className="companion-controls absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-5 py-2.5 rounded-full bg-black/50 backdrop-blur-md border border-white/10 z-10">
      {/* 1. Camera toggle — always clickable */}
      <button
        type="button"
        onClick={onToggleCamera}
        className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
          cameraEnabled
            ? 'bg-white/10 text-white hover:bg-white/20'
            : 'bg-white/5 text-white/40 hover:text-white/60'
        }`}
        title={cameraEnabled ? t('companion.cameraOn') : t('companion.cameraOff')}
      >
        <span className="material-symbols-outlined text-xl">
          {cameraEnabled ? 'videocam' : 'videocam_off'}
        </span>
      </button>

      {/* 2. Screen share — always clickable */}
      <button
        type="button"
        onClick={onScreenShareClick}
        className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
          isSharing
            ? 'bg-orange-500/30 text-orange-300'
            : 'bg-white/10 text-white hover:bg-white/20'
        }`}
        title={isSharing ? t('companion.screenShare.stop') : t('companion.screenShare.start')}
      >
        <span className="material-symbols-outlined text-xl">
          {isSharing ? 'present_to_all' : 'screen_share'}
        </span>
      </button>

      {/* 3. Mic toggle — always clickable */}
      <button
        type="button"
        onClick={onToggleMic}
        className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
          micEnabled
            ? 'bg-white/10 text-white hover:bg-white/20'
            : 'bg-white/5 text-white/40 hover:text-white/60'
        }`}
        title={micEnabled ? t('companion.micOn') : t('companion.micOff')}
      >
        <span className="material-symbols-outlined text-xl">
          {micEnabled ? 'mic' : 'mic_off'}
        </span>
      </button>

      {/* Stop generation (when generating) */}
      {generating && (
        <button
          type="button"
          onClick={onStop}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-500/30 text-orange-300 hover:bg-orange-500/50 transition-all"
          title="Stop"
        >
          <span className="material-symbols-outlined text-xl">stop</span>
        </button>
      )}

      {/* Separator */}
      <div className="w-px h-7 bg-white/10" />

      {/* 4. Speaker toggle */}
      <button
        type="button"
        onClick={() => setSpeakerOn(!speakerOn)}
        className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
          speakerOn
            ? 'bg-white/10 text-white hover:bg-white/20'
            : 'bg-white/5 text-white/40'
        }`}
        title={t('companion.speaker')}
      >
        <span className="material-symbols-outlined text-xl">
          {speakerOn ? 'volume_up' : 'volume_off'}
        </span>
      </button>

      {/* 5. Call / Hang Up */}
      {isConnected ? (
        <button
          type="button"
          onClick={onDisconnect}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 transition-all shadow-lg"
          title={t('companion.hangUp')}
        >
          <span className="material-symbols-outlined text-xl">call_end</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleConnectClick}
          disabled={status === 'connecting'}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500 text-white hover:bg-green-600 transition-all disabled:opacity-40 shadow-lg"
          title={t('companion.call')}
        >
          <span className="material-symbols-outlined text-xl">
            {status === 'connecting' ? 'hourglass_top' : 'call'}
          </span>
        </button>
      )}
    </div>
  )
}
