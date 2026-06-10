import { useState, useCallback } from 'react'
import { useTranslation } from '../../i18n'
import { useCompanionStore } from '../../stores/companionStore'

interface ScreenShareDialogProps {
  onStartScreenShare: () => void
}

export function ScreenShareDialog({ onStartScreenShare }: ScreenShareDialogProps) {
  const t = useTranslation()
  const open = useCompanionStore((s) => s.screenShareDialogOpen)
  const setScreenShareDialogOpen = useCompanionStore((s) => s.setScreenShareDialogOpen)
  const [sourceType, setSourceType] = useState<'screen' | 'window'>('screen')

  const handleCancel = useCallback(() => {
    setScreenShareDialogOpen(false)
  }, [setScreenShareDialogOpen])

  const handleStart = useCallback(() => {
    setScreenShareDialogOpen(false)
    onStartScreenShare()
  }, [setScreenShareDialogOpen, onStartScreenShare])

  if (!open) return null

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-sm" onClick={handleCancel} />

      {/* Dialog */}
      <div className="relative w-[340px] p-5 rounded-2xl bg-black/70 backdrop-blur-xl border border-white/10 shadow-2xl">
        <h3 className="text-white/80 text-sm font-medium mb-4 text-center">
          {t('companion.screenShare.dialog.title')}
        </h3>

        {/* Source selector */}
        <div className="mb-5 flex gap-2">
          <button
            type="button"
            onClick={() => setSourceType('screen')}
            className={`flex-1 flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all ${
              sourceType === 'screen'
                ? 'bg-orange-500/20 border-orange-400/40'
                : 'bg-white/[0.04] border-transparent hover:bg-white/[0.08]'
            }`}
          >
            <span className="material-symbols-outlined text-xl text-white/60">monitor</span>
            <span className="text-white/70 text-xs">{t('companion.screenShare.dialog.entireScreen')}</span>
          </button>
          <button
            type="button"
            onClick={() => setSourceType('window')}
            className={`flex-1 flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all ${
              sourceType === 'window'
                ? 'bg-orange-500/20 border-orange-400/40'
                : 'bg-white/[0.04] border-transparent hover:bg-white/[0.08]'
            }`}
          >
            <span className="material-symbols-outlined text-xl text-white/60">window</span>
            <span className="text-white/70 text-xs">{t('companion.screenShare.dialog.window')}</span>
          </button>
        </div>

        {/* Privacy notice */}
        <p className="text-white/25 text-[11px] leading-relaxed mb-5">
          {t('companion.screenShare.dialog.privacy')}
        </p>

        {/* Action buttons */}
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={handleCancel}
            className="flex-1 h-9 rounded-xl bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70 transition-all text-xs font-medium"
          >
            {t('companion.screenShare.dialog.cancel')}
          </button>
          <button
            type="button"
            onClick={handleStart}
            className="flex-1 h-9 rounded-xl bg-orange-500/30 text-orange-200 hover:bg-orange-500/50 transition-all text-xs font-medium"
          >
            {t('companion.screenShare.dialog.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
