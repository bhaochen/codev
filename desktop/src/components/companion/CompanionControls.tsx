import { useTranslation } from '../../i18n'
import type { CompanionStatus } from '../../types/companion'

interface CompanionControlsProps {
  status: CompanionStatus
  micEnabled: boolean
  cameraEnabled: boolean
  generating: boolean
  onToggleMic: () => void
  onToggleCamera: () => void
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
  onToggleMic,
  onToggleCamera,
  onConnect,
  onDisconnect,
  onStop,
  onResumeAudio,
}: CompanionControlsProps) {
  const t = useTranslation()
  const isConnected = status === 'connected'

  return (
    <div className="companion-controls absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-6 py-3 rounded-2xl bg-black/50 backdrop-blur-md border border-white/10">
      {/* Mic toggle */}
      <button
        type="button"
        onClick={onToggleMic}
        disabled={!isConnected}
        className={`flex h-10 w-10 items-center justify-center rounded-xl transition-all ${
          micEnabled
            ? 'bg-white/10 text-white hover:bg-white/20'
            : 'bg-red-500/20 text-red-400'
        } disabled:opacity-40`}
        title={micEnabled ? t('companion.micOn') : t('companion.micOff')}
      >
        <span className="material-symbols-outlined text-xl">
          {micEnabled ? 'mic' : 'mic_off'}
        </span>
      </button>

      {/* Camera toggle */}
      <button
        type="button"
        onClick={onToggleCamera}
        disabled={!isConnected}
        className={`flex h-10 w-10 items-center justify-center rounded-xl transition-all ${
          cameraEnabled
            ? 'bg-white/10 text-white hover:bg-white/20'
            : 'bg-red-500/20 text-red-400'
        } disabled:opacity-40`}
        title={cameraEnabled ? t('companion.cameraOn') : t('companion.cameraOff')}
      >
        <span className="material-symbols-outlined text-xl">
          {cameraEnabled ? 'videocam' : 'videocam_off'}
        </span>
      </button>

      <div className="w-px h-8 bg-white/10" />

      {/* Stop generation */}
      {generating && (
        <button
          type="button"
          onClick={onStop}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/30 text-red-400 hover:bg-red-500/50 transition-all"
          title="Stop"
        >
          <span className="material-symbols-outlined text-xl">stop</span>
        </button>
      )}

      {/* Connect / Disconnect */}
      {isConnected ? (
        <button
          type="button"
          onClick={() => {
            onDisconnect()
          }}
          className="flex h-10 items-center gap-2 rounded-xl bg-red-500/20 px-4 text-red-400 hover:bg-red-500/30 transition-all text-sm font-medium"
        >
          <span className="material-symbols-outlined text-lg">link_off</span>
          {t('companion.disconnect')}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            onConnect()
            // Resume audio context on user gesture
            onResumeAudio()
          }}
          disabled={status === 'connecting'}
          className="flex h-10 items-center gap-2 rounded-xl bg-purple-600/30 px-4 text-purple-300 hover:bg-purple-600/50 transition-all text-sm font-medium disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-lg">
            {status === 'connecting' ? 'hourglass_top' : 'link'}
          </span>
          {status === 'connecting' ? t('companion.status.connecting') : t('companion.connect')}
        </button>
      )}
    </div>
  )
}
