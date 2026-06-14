/**
 * Desktop auth store that reads/writes ~/.claude.json directly via Rust Tauri commands.
 * Mirrors TUI's src/utils/auth.ts save* functions.
 *
 * This removes the dependency on cc-haha's /api/cli-auth HTTP endpoint.
 */
import { create } from 'zustand'
import { getTuiConfig, saveTuiConfigPatch, clearConfigCache } from '../api/config'

type AuthProvider = 'anthropic' | 'openai' | 'openrouter' | 'local' | 'opencode' | 'nvidia'

type CliAuthStore = {
  authProvider: AuthProvider | null
  nvidiaApiKey: string | null
  openRouterApiKey: string | null
  openAiApiKey: string | null
  openCodeApiKey: string | null
  openCodeModelName: string | null
  localBaseUrl: string | null
  localModelName: string | null
  isLoading: boolean
  error: string | null

  fetchAuth: () => Promise<void>
  setAuthProvider: (provider: AuthProvider) => Promise<void>
  saveNvidiaApiKey: (apiKey: string) => Promise<void>
  saveOpenRouterApiKey: (apiKey: string) => Promise<void>
  saveOpenAIApiKey: (apiKey: string) => Promise<void>
  saveOpenCodeApiKey: (apiKey: string, modelName?: string) => Promise<void>
  saveLocalModelConfig: (baseUrl: string, modelName: string) => Promise<void>
  clearAuth: () => Promise<void>
}

export const useCliAuthStore = create<CliAuthStore>((set) => ({
  authProvider: null,
  nvidiaApiKey: null,
  openRouterApiKey: null,
  openAiApiKey: null,
  openCodeApiKey: null,
  openCodeModelName: null,
  localBaseUrl: null,
  localModelName: null,
  isLoading: false,
  error: null,

  fetchAuth: async () => {
    set({ isLoading: true, error: null })
    try {
      const config = await getTuiConfig()
      // Map TUI's authProvider names to our store's names
      // TUI uses 'anthropic' → our 'anthropic' means firstParty
      const authProvider = config.authProvider ?? null
      set({
        authProvider,
        nvidiaApiKey: config.nvidiaApiKey ?? null,
        openRouterApiKey: config.openRouterApiKey ?? null,
        openAiApiKey: (config.openAiApiKey || config.openAiAccessToken) ?? null,
        openCodeApiKey: config.openCodeApiKey ?? null,
        openCodeModelName: config.openCodeModelName ?? null,
        localBaseUrl: config.localBaseUrl ?? null,
        localModelName: config.localModelName ?? null,
        isLoading: false,
      })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  setAuthProvider: async (provider: AuthProvider) => {
    set({ isLoading: true, error: null })
    try {
      await saveTuiConfigPatch({ authProvider: provider })
      clearConfigCache()
      set({ authProvider: provider, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveNvidiaApiKey: async (apiKey: string) => {
    set({ isLoading: true, error: null })
    try {
      await saveTuiConfigPatch({
        authProvider: 'nvidia',
        nvidiaApiKey: apiKey,
      })
      clearConfigCache()
      set({ authProvider: 'nvidia', nvidiaApiKey: apiKey, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveOpenRouterApiKey: async (apiKey: string) => {
    set({ isLoading: true, error: null })
    try {
      await saveTuiConfigPatch({
        authProvider: 'openrouter',
        openRouterApiKey: apiKey,
      })
      clearConfigCache()
      set({ authProvider: 'openrouter', openRouterApiKey: apiKey, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveOpenAIApiKey: async (apiKey: string) => {
    set({ isLoading: true, error: null })
    try {
      await saveTuiConfigPatch({
        authProvider: 'openai',
        openAiApiKey: apiKey,
        openAiAccessToken: undefined, // Clear OAuth token when switching to API key
      })
      clearConfigCache()
      set({ authProvider: 'openai', openAiApiKey: apiKey, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveOpenCodeApiKey: async (apiKey: string, modelName?: string) => {
    set({ isLoading: true, error: null })
    try {
      await saveTuiConfigPatch({
        authProvider: 'opencode',
        openCodeApiKey: apiKey || undefined,
        openCodeModelName: modelName || undefined,
      })
      clearConfigCache()
      set({
        authProvider: 'opencode',
        openCodeApiKey: apiKey,
        ...(modelName ? { openCodeModelName: modelName } : {}),
        isLoading: false,
      })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveLocalModelConfig: async (baseUrl: string, modelName: string) => {
    set({ isLoading: true, error: null })
    try {
      await saveTuiConfigPatch({
        authProvider: 'local',
        localBaseUrl: baseUrl,
        localModelName: modelName,
      })
      clearConfigCache()
      set({
        authProvider: 'local',
        localBaseUrl: baseUrl,
        localModelName: modelName,
        isLoading: false,
      })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  clearAuth: async () => {
    set({ isLoading: true, error: null })
    try {
      // Clear by writing null values for all auth fields
      await saveTuiConfigPatch({
        authProvider: null,
        primaryApiKey: undefined,
        openAiApiKey: undefined,
        openAiAccessToken: undefined,
        openRouterApiKey: undefined,
        nvidiaApiKey: undefined,
        openCodeApiKey: undefined,
        openCodeModelName: undefined,
        localBaseUrl: undefined,
        localModelName: undefined,
      })
      clearConfigCache()
      set({
        authProvider: null,
        nvidiaApiKey: null,
        openRouterApiKey: null,
        openAiApiKey: null,
        openCodeApiKey: null,
        openCodeModelName: null,
        localBaseUrl: null,
        localModelName: null,
        isLoading: false,
      })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
}))