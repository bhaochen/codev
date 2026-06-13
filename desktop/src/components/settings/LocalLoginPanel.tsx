import { useEffect, useState } from 'react'
import { useCliAuthStore } from '../../stores/cliAuthStore'

export function LocalLoginPanel() {
  const { localBaseUrl, localModelName, saveLocalModelConfig, isLoading } = useCliAuthStore()
  const [url, setUrl] = useState('')
  const [modelName, setModelName] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const defaultUrl = 'http://127.0.0.1:8001'

  useEffect(() => {
    if (localBaseUrl) setUrl(localBaseUrl)
    if (localModelName) setModelName(localModelName)
  }, [localBaseUrl, localModelName])

  const handleSave = async () => {
    const finalUrl = url.trim() || defaultUrl
    const finalModel = modelName.trim() || 'default'
    if (!finalUrl) { setStatus('Please enter a URL'); return }
    try {
      new URL(finalUrl) // validate URL
    } catch {
      setStatus('Invalid URL format')
      return
    }
    setStatus(null)
    try {
      await saveLocalModelConfig(finalUrl, finalModel)
      setStatus('Saved!')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="text-sm text-[var(--color-text-secondary)]">
        Configure a local model server (Ollama, LM Studio, vLLM, etc.).
      </div>
      <div className="flex flex-col gap-2">
        <div>
          <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">Server URL</label>
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder={localBaseUrl || defaultUrl}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:border-[var(--color-brand)] focus:outline-none"
          />
        </div>
        <div>
          <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">Model Name</label>
          <input
            type="text"
            value={modelName}
            onChange={e => setModelName(e.target.value)}
            placeholder={localModelName || 'default'}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:border-[var(--color-brand)] focus:outline-none"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={isLoading}
          className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm text-white hover:brightness-105 disabled:opacity-50"
        >
          {isLoading ? 'Saving...' : 'Save'}
        </button>
      </div>
      {status && (
        <div className={`text-xs ${status === 'Saved!' ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
          {status}
        </div>
      )}
    </div>
  )
}
