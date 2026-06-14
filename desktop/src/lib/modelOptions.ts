/**
 * Desktop model options utility.
 *
 * Mirrors key logic from TUI's src/utils/model/modelOptions.ts
 * but adapted for the desktop React context.
 *
 * Core value: provider-tier-aware model filtering (Max gets Opus,
 * Pro gets Sonnet, etc.) and environment-variable overrides that
 * TUI supports but the cc-haha /api/models endpoint doesn't expose.
 */

import type { ModelInfo } from '../types/settings'

export type ModelOption = {
  value: string | null  // null = default
  label: string
  description: string
  descriptionForModel?: string
}

/** Determine the effective auth provider from ~/.claude.json config. */
export async function getConfigAuthProvider(): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    const config = await invoke<Record<string, unknown>>('get_claude_config')
    return (config?.authProvider as string | null) ?? null
  } catch {
    return null
  }
}

// Provider-specific model strings (simplified from TUI's modelStrings.ts)
// Desktop uses these for display labels when the full TUI module isn't loaded.
export const DESKTOP_MODEL_STRINGS = {
  opus46: 'claude-opus-4-6-20250514',
  sonnet46: 'claude-sonnet-4-6-20250608',
  haiku45: 'claude-haiku-4-5-20250522',
  opus45: 'claude-opus-4-5-20241022',
  sonnet45: 'claude-sonnet-4-5-20241022',
  haiku35: 'claude-haiku-3-5-20241022',
} as const

/**
 * Build ModelOption[] for a given provider and subscription tier.
 * This mirrors the logic in TUI's getModelOptions() but without the
 * full TUI bootstrap/graphbook dependency tree.
 *
 * @param provider - The active API provider from config
 * @param isSubscriber - Whether the user has a claude.ai subscription
 * @param subscriptionType - 'max' | 'pro' | 'team' | null
 * @param fastMode - Whether fast mode is enabled
 * @param availableModels - Existing model list from cc-haha (supplemental)
 */
export function buildModelOptions(
  provider: string | null,
  _isSubscriber: boolean,
  subscriptionType: string | null,
  fastMode: boolean,
  availableModels: ModelInfo[],
): ModelOption[] {
  const opts: ModelOption[] = []

  // Default always first
  opts.push({
    value: null,
    label: 'Default (recommended)',
    description: getDefaultDescription(subscriptionType),
  })

  if (!provider) {
    return opts
  }

  const is3P = provider !== 'firstParty'

  switch (provider) {
    case 'firstParty': {
      // Sonnet 4.6 is default for PAYG / non-subscriber
      opts.push(makeSonnet46(is3P))
      // Sonnet 1M if available
      opts.push(makeSonnet46_1M(is3P))
      // Opus 4.6 alternatives
      if (isOpus1mMergeEnabled(_isSubscriber, subscriptionType)) {
        opts.push(makeOpus46_1M(fastMode, is3P))
      } else {
        opts.push(makeOpus46(fastMode, is3P))
      }
      // Haiku
      opts.push(makeHaiku45(is3P))
      break
    }

    case 'openai': {
      // Map to GPT models for display
      opts.push({ value: 'gpt-5.4', label: 'GPT-5.4', description: 'GPT-5.4 · Recommended for most coding tasks' })
      opts.push({ value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'GPT-5.4 Mini · Fastest OpenAI option' })
      break
    }

    case 'opencode': {
      // OpenCode models - use available list or fall back to defaults
      if (availableModels.length > 0) {
        for (const m of availableModels) {
          opts.push({ value: m.id, label: m.name || m.id, description: m.description || 'OpenCode model' })
        }
      } else {
        // Fallback defaults from DESKTOP_MODEL_STRINGS
        opts.push({ value: 'big-pickle', label: 'Big Pickle', description: '旗舰模型，限时免费，适合复杂任务' })
        opts.push({ value: 'gpt-5-nano', label: 'GPT 5 Nano', description: '永久免费，轻量快速，隐私安全' })
      }
      break
    }

    case 'nvidia': {
      if (availableModels.length > 0) {
        for (const m of availableModels) {
          opts.push({ value: m.id, label: m.name || m.id, description: m.description || 'NVIDIA NIM model' })
        }
      }
      break
    }

    case 'local': {
      // Local models come from availableModels
      for (const m of availableModels) {
        opts.push({ value: m.id, label: m.name || m.id, description: m.description || 'Local model' })
      }
      break
    }

    case 'openrouter': {
      if (availableModels.length > 0) {
        for (const m of availableModels) {
          opts.push({ value: m.id, label: m.name || m.id, description: m.description || 'OpenRouter model' })
        }
      }
      break
    }

    default:
      // For unknown providers, supplement with availableModels
      for (const m of availableModels) {
        opts.push({ value: m.id, label: m.name || m.id, description: m.description || 'Model' })
      }
      break
  }

  return opts
}

function getDefaultDescription(subscriptionType: string | null): string {
  if (subscriptionType === 'max') return 'Opus 4.6 · Most capable for complex work'
  if (subscriptionType === 'pro') return 'Sonnet 4.6 · Best for everyday tasks'
  return 'Sonnet 4.6 · Best for everyday tasks'
}

function isOpus1mMergeEnabled(_isSubscriber: boolean, subscriptionType: string | null): boolean {
  // Only enable 1M for Max/Team Premium subscribers on firstParty
  if (subscriptionType === 'max' || subscriptionType === 'team') return true
  return false
}

function makeSonnet46(is3P: boolean): ModelOption {
  return {
    value: 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 4.6 · Best for everyday tasks${is3P ? '' : ' · $3 / M input, $15 / M output'}`,
    descriptionForModel: 'Sonnet 4.6 - best for everyday tasks',
  }
}

function makeSonnet46_1M(is3P: boolean): ModelOption {
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 with 1M context window${is3P ? '' : ' · $3 / M input, $15 / M output'}`,
    descriptionForModel: 'Sonnet 4.6 with 1M context window - for long sessions',
  }
}

function makeOpus46(fastMode: boolean, is3P: boolean): ModelOption {
  const suffix = fastMode && !is3P ? ' · ⚡ $7.50 / M input, $37.50 / M output' : ''
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work${suffix}`,
    descriptionForModel: 'Opus 4.6 - most capable for complex work',
  }
}

function makeOpus46_1M(fastMode: boolean, is3P: boolean): ModelOption {
  const suffix = fastMode && !is3P ? ' · ⚡ $7.50 / M input, $37.50 / M output' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 with 1M context${suffix}`,
    descriptionForModel: 'Opus 4.6 with 1M context - most capable for complex work',
  }
}

function makeHaiku45(is3P: boolean): ModelOption {
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ' · $0.08 / M input, $0.40 / M output'}`,
    descriptionForModel: 'Haiku 4.5 - fastest for quick answers',
  }
}