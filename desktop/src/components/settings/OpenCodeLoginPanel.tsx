import { useState } from 'react'
import { useCliAuthStore } from '../../stores/cliAuthStore'

export function OpenCodeLoginPanel() {
  const { openCodeApiKey, saveOpenCodeApiKey, isLoading } = useCliAuthStore()
  const [mode, setMode] = useState<'menu' | 'api_key'>('menu')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const handleFreeModels = async () => {
    setStatus(null)
    try {
      await saveOpenCodeApiKey('', '')
      setStatus('Free models configured!')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSave = async () => {
    if (!apiKey.trim()) { setStatus('Please enter an API key'); return }
    setStatus(null)
    try {
      await saveOpenCodeApiKey(apiKey.trim(), '')
      setStatus('Saved!')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const handleClear = async () => {
    await useCliAuthStore.getState().clearAuth()
    setApiKey('')
    setStatus('Cleared')
  }

  if (mode === 'api_key') {
    return (
      <div className="flex flex-col gap-3 py-2">
        <div className="text-sm text-[var(--color-text-secondary)]">
          OpenCode Zen API keys use pay-as-you-go billing. Sign up at <a href="https://opencode.ai/zen" className="text-[var(--color-brand)]" target="_blank">opencode.ai/zen</a> to get your key.
        </div>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={openCodeApiKey ? '••••••••' : 'oc-...'}
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:border-[var(--color-brand)] focus:outline-none"
          />
          <button
            onClick={handleSave}
            disabled={isLoading}
            className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm text-white hover:brightness-105 disabled:opacity-50"
          >
            {isLoading ? 'Saving...' : 'Save'}
          </button>
        </div>
        <button
          onClick={() => { setMode('menu'); setApiKey(''); setStatus(null) }}
          className="self-start text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
        >
          &larr; Back to options
        </button>
        {status && (
          <div className={`text-xs ${status === 'Saved!' ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
            {status}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="text-sm text-[var(--color-text-secondary)]">
        OpenCode Zen offers free models (no API key needed) or paid models via API key.
      </div>
      {status && (
        <div className={`text-xs ${status === 'Saved!' || status === 'Free models configured!' ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
          {status}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <button
          onClick={handleFreeModels}
          disabled={isLoading}
          className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-4 py-3 text-left hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary)]">Use free models</div>
            <div className="text-xs text-[var(--color-text-tertiary)]">No API key required</div>
          </div>
        </button>
        <button
          onClick={() => { setMode('api_key'); setApiKey('') }}
          className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-4 py-3 text-left hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)]"
        >
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary)]">Paste OpenCode Zen API key</div>
            <div className="text-xs text-[var(--color-text-tertiary)]">Access paid models, pay-as-you-go</div>
          </div>
        </button>
        {openCodeApiKey && (
          <button
            onClick={handleClear}
            className="self-start text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-error)]"
          >
            Clear credentials
          </button>
        )}
      </div>
    </div>
  )
}
