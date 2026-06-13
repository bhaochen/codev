import { useEffect, useState } from 'react'
import { useCliAuthStore } from '../../stores/cliAuthStore'
import { AnthropicLoginPanel } from './AnthropicLoginPanel'
import { OpenAILoginPanel } from './OpenAILoginPanel'
import { NvidiaLoginPanel } from './NvidiaLoginPanel'
import { OpenRouterLoginPanel } from './OpenRouterLoginPanel'
import { OpenCodeLoginPanel } from './OpenCodeLoginPanel'
import { LocalLoginPanel } from './LocalLoginPanel'
import type { AuthProvider } from '../../api/cliAuth'

const PROVIDER_OPTIONS: { id: AuthProvider; name: string; description: string; icon: string }[] = [
  { id: 'anthropic', name: 'Anthropic', description: 'Subscription login, Console API billing, or Bedrock/Foundry/Vertex', icon: '🤖' },
  { id: 'openai', name: 'OpenAI / Codex', description: 'Codex login, Codex auth import, or OpenAI API key', icon: '🤖' },
  { id: 'openrouter', name: 'OpenRouter', description: 'OpenRouter API key via Responses API', icon: '🔀' },
  { id: 'opencode', name: 'OpenCode Zen', description: 'Free models (Big Pickle, GPT 5 Nano) or Zen API key', icon: '✨' },
  { id: 'local', name: 'Local', description: 'Local model server (Ollama, LM Studio, vLLM, etc.)', icon: '💻' },
  { id: 'nvidia', name: 'NVIDIA', description: 'NVIDIA NIM API key from build.nvidia.com', icon: '🔷' },
]

const LOGIN_PANEL_MAP: Record<AuthProvider, React.FC> = {
  anthropic: AnthropicLoginPanel,
  openai: OpenAILoginPanel,
  openrouter: OpenRouterLoginPanel,
  opencode: OpenCodeLoginPanel,
  local: LocalLoginPanel,
  nvidia: NvidiaLoginPanel,
}

export function CliLoginProviderSettings() {
  const { authProvider, isLoading, fetchAuth, clearAuth } = useCliAuthStore()
  const [expandedProvider, setExpandedProvider] = useState<AuthProvider | null>(null)

  useEffect(() => {
    fetchAuth()
  }, [fetchAuth])

  const handleProviderClick = (providerId: AuthProvider) => {
    if (expandedProvider === providerId) {
      setExpandedProvider(null)
    } else {
      setExpandedProvider(providerId)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Provider</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mt-0.5">
          Choose which provider to use. Pick a provider first, then configure the login method.
        </p>
      </div>

      {authProvider && (
        <div className="mb-3 px-4 py-2 rounded-lg bg-[var(--color-surface-container)] border border-[var(--color-border)]">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--color-text-secondary)]">
              Current provider: <strong className="text-[var(--color-text-primary)]">{PROVIDER_OPTIONS.find(p => p.id === authProvider)?.name || authProvider}</strong>
            </span>
            <button
              onClick={clearAuth}
              disabled={isLoading}
              className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-error)] disabled:opacity-50"
            >
              Clear &amp; change
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {PROVIDER_OPTIONS.map((provider) => {
          const isActive = provider.id === authProvider
          const isExpanded = expandedProvider === provider.id
          const LoginPanel = LOGIN_PANEL_MAP[provider.id]

          return (
            <div
              key={provider.id}
              className={`rounded-xl border transition-all ${
                isExpanded && isActive
                  ? 'border-[var(--color-brand)] bg-[var(--color-surface-container)] shadow-[var(--shadow-focus-ring)]'
                  : isActive
                    ? 'border-[var(--color-success)]/30 bg-[var(--color-surface-container)]'
                    : isExpanded
                      ? 'border-[var(--color-border-focus)]'
                      : 'border-[var(--color-border)] hover:border-[var(--color-border-focus)]'
              }`}
            >
              <button
                className={`w-full flex items-center gap-4 px-4 py-3.5 text-left ${!isExpanded && !isActive ? 'cursor-pointer' : ''}`}
                onClick={() => handleProviderClick(provider.id)}
              >
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                  isActive ? 'bg-[var(--color-success)]' : isExpanded ? 'bg-[var(--color-brand)]' : 'bg-[var(--color-text-tertiary)]'
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--color-text-primary)]">{provider.name}</span>
                    {isActive && authProvider && (
                      <span className="px-1.5 py-0.5 text-[10px] font-bold rounded border border-[var(--color-success)]/18 bg-[var(--color-success)]/14 text-[var(--color-success)] leading-none">Active</span>
                    )}
                  </div>
                  <div className="text-xs text-[var(--color-text-tertiary)] mt-0.5">{provider.description}</div>
                </div>
                <svg
                  className={`w-4 h-4 text-[var(--color-text-tertiary)] transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 pt-2 border-t border-[var(--color-border-separator)]">
                  <LoginPanel />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
