import { useCallback } from 'react'
import { useTranslation } from '../../i18n'
import { useCompanionStore, SCENARIOS } from '../../stores/companionStore'

export function ScenarioSelector() {
  const t = useTranslation()
  const open = useCompanionStore((s) => s.scenarioPanelOpen)
  const currentScenario = useCompanionStore((s) => s.scenario)
  const setScenario = useCompanionStore((s) => s.setScenario)
  const setScenarioPanelOpen = useCompanionStore((s) => s.setScenarioPanelOpen)

  const handleSelect = useCallback(
    (id: string) => {
      setScenario(id)
    },
    [setScenario],
  )

  const handleClose = useCallback(() => {
    setScenarioPanelOpen(false)
  }, [setScenarioPanelOpen])

  if (!open) return null

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center pt-20">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-sm" onClick={handleClose} />

      {/* Grid panel */}
      <div className="relative w-[420px] max-h-[70vh] p-5 rounded-2xl bg-black/60 backdrop-blur-xl border border-white/10 shadow-2xl">
        <h3 className="text-white/70 text-sm font-medium mb-4 text-center">
          {t('companion.scenario.select')}
        </h3>

        <div className="grid grid-cols-3 gap-2.5">
          {SCENARIOS.map((scenario) => {
            const isActive = currentScenario === scenario.id
            return (
              <button
                key={scenario.id}
                type="button"
                onClick={() => handleSelect(scenario.id)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl transition-all border ${
                  isActive
                    ? 'bg-orange-500/20 border-orange-400/40'
                    : 'bg-white/[0.04] border-transparent hover:bg-white/[0.08]'
                }`}
              >
                <span
                  className={`material-symbols-outlined text-2xl ${
                    isActive ? 'text-orange-300' : 'text-white/50'
                  }`}
                >
                  {scenario.icon}
                </span>
                <span className="text-white/80 text-xs font-medium">{scenario.name}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
