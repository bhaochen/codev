import { useEffect, useState } from 'react'
import { useCliAuthStore } from '../../stores/cliAuthStore'

export function NvidiaLoginPanel() {
  const { nvidiaApiKey, saveNvidiaApiKey, isLoading } = useCliAuthStore()
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (nvidiaApiKey) setApiKey(nvidiaApiKey)
  }, [nvidiaApiKey])

  const handleSave = async () => {
    if (!apiKey.trim()) { setStatus('Please enter an API key'); return }
    setStatus(null)
    try {
      await saveNvidiaApiKey(apiKey.trim())
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

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="text-sm text-[var(--color-text-secondary)]">
        Paste your NVIDIA API key to use models from the NVIDIA API catalog via the OpenAI-compatible endpoint.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={nvidiaApiKey ? '••••••••' : 'sk-...'}
          className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:border-[var(--color-brand)] focus:outline-none"
        />
        <button
          onClick={handleSave}
          disabled={isLoading}
          className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm text-white hover:brightness-105 disabled:opacity-50"
        >
          {isLoading ? 'Saving...' : 'Save'}
        </button>
        {nvidiaApiKey && (
          <button
            onClick={handleClear}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          >
            Clear
          </button>
        )}
      </div>
      {status && (
        <div className={`text-xs ${status === 'Saved!' ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
          {status}
        </div>
      )}
    </div>
  )
}
