/**
 * TUI-style configuration reading layer for desktop.
 *
 * Mirrors TUI's src/utils/config.ts and src/utils/env.ts reading patterns,
 * using Rust Tauri commands to read ~/.claude.json directly instead of going
 * through the cc-haha sidecar HTTP API.
 *
 * This allows the desktop app to use the same configuration files as the TUI,
 * making cc-haha's /api/cli-auth endpoint unnecessary for config reads.
 */

import { invoke } from '@tauri-apps/api/core'

// Re-export types that mirror TUI's GlobalConfig shape
export type TuiGlobalConfig = {
  // Auth provider
  authProvider?: 'anthropic' | 'openrouter' | 'openai' | 'local' | 'opencode' | 'nvidia' | null

  // API Keys
  primaryApiKey?: string
  openAiApiKey?: string
  openAiAccessToken?: string
  openRouterApiKey?: string
  nvidiaApiKey?: string
  openCodeApiKey?: string
  openCodeModelName?: string
  localBaseUrl?: string
  localModelName?: string

  // OAuth
  oauthAccount?: {
    emailAddress?: string
    organizationName?: string
    uuid?: string
  }

  // Model selection
  model?: string
  effortLevel?: string

  // Other fields we don't actively use but preserve
  [key: string]: unknown
}

let configCache: TuiGlobalConfig | null = null
let configCacheTime = 0
const CONFIG_CACHE_TTL = 2000 // 2 seconds — balance freshness vs perf

/**
 * Get the global Claude config (~/.claude.json) from the Rust layer.
 * Results are cached for CONFIG_CACHE_TTL ms to avoid excessive Rust IPC calls.
 */
export async function getTuiConfig(): Promise<TuiGlobalConfig> {
  const now = Date.now()
  if (configCache !== null && now - configCacheTime < CONFIG_CACHE_TTL) {
    return configCache
  }

  try {
    const result = await invoke<unknown>('get_claude_config')
    if (result === null) {
      configCache = {}
    } else {
      configCache = result as TuiGlobalConfig
    }
    configCacheTime = now
    return configCache!
  } catch (err) {
    console.error('[config] failed to read ~/.claude.json:', err)
    return {}
  }
}

/**
 * Save a partial patch to ~/.claude.json (deep-merged with existing content).
 */
export async function saveTuiConfigPatch(patch: Partial<TuiGlobalConfig>): Promise<void> {
  await invoke('save_claude_config', { patch })
  // Invalidate cache so next read picks up the change
  configCache = null
  configCacheTime = 0
}

/**
 * Clear the in-memory config cache.
 * Call this after making config changes to force a fresh read.
 */
export function clearConfigCache(): void {
  configCache = null
  configCacheTime = 0
}