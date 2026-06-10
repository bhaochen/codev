import { useCallback } from 'react'
import { useTranslation } from '../../i18n'
import { useCompanionStore, SCENARIOS } from '../../stores/companionStore'

export function CompanionTopBar() {
  const t = useTranslation()
  const scenario = useCompanionStore((s) => s.scenario)
  const subtitleEnabled = useCompanionStore((s) => s.subtitleEnabled)

  const setScenarioPanelOpen = useCompanionStore((s) => s.setScenarioPanelOpen)
  const setSubtitleEnabled = useCompanionStore((s) => s.setSubtitleEnabled)

  const currentScenario = scenario
    ? SCENARIOS.find((s) => s.id === scenario)
    : null

  const handleScenarioClick = useCallback(() => {
    setScenarioPanelOpen(true)
  }, [setScenarioPanelOpen])

  const handleSubtitleToggle = useCallback(() => {
    setSubtitleEnabled(!subtitleEnabled)
  }, [subtitleEnabled, setSubtitleEnabled])

  return (
    <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-4 pt-4 pb-2">
      {/* Left spacer */}
      <div className="w-9" />

      {/* Center: scenario selector capsule */}
      <button
        type="button"
        onClick={handleScenarioClick}
        className="flex items-center gap-1.5 px-3.5 h-8 rounded-full bg-black/30 backdrop-blur-md border border-white/10 hover:bg-white/10 transition-all text-white/70 hover:text-white"
      >
        {currentScenario ? (
          <>
            <span className="material-symbols-outlined text-base">{currentScenario.icon}</span>
            <span className="text-xs font-medium">{currentScenario.name}</span>
          </>
        ) : (
          <span className="text-xs font-medium">{t('companion.scenario.select')}</span>
        )}
        <span className="material-symbols-outlined text-sm text-white/30">expand_more</span>
      </button>

      {/* Right: subtitle toggle */}
      <button
        type="button"
        onClick={handleSubtitleToggle}
        className={`flex h-8 w-8 items-center justify-center rounded-full backdrop-blur-md transition-all text-xs font-bold ${
          subtitleEnabled
            ? 'bg-orange-500/40 text-orange-200'
            : 'bg-black/30 text-white/40 hover:text-white/60'
        }`}
        title={t('companion.subtitle')}
      >
        字
      </button>
    </div>
  )
}
