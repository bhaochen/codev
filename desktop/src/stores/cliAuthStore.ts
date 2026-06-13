import { create } from 'zustand'
import { cliAuthApi, type AuthProvider, type CliAuthConfig } from '../api/cliAuth'

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
      const config = await cliAuthApi.get()
      set({
        authProvider: config.authProvider,
        nvidiaApiKey: config.nvidiaApiKey || null,
        openRouterApiKey: config.openRouterApiKey || null,
        openAiApiKey: config.openAiApiKey || config.openAiAccessToken || null,
        openCodeApiKey: config.openCodeApiKey || null,
        openCodeModelName: config.openCodeModelName || null,
        localBaseUrl: config.localBaseUrl || null,
        localModelName: config.localModelName || null,
        isLoading: false,
      })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  setAuthProvider: async (provider: AuthProvider) => {
    set({ isLoading: true, error: null })
    try {
      await cliAuthApi.update({ authProvider: provider })
      await cliAuthApi.invalidateCache()
      set({ authProvider: provider, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveNvidiaApiKey: async (apiKey: string) => {
    set({ isLoading: true, error: null })
    try {
      await cliAuthApi.update({ authProvider: 'nvidia', nvidiaApiKey: apiKey })
      await cliAuthApi.invalidateCache()
      set({ authProvider: 'nvidia', nvidiaApiKey: apiKey, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveOpenRouterApiKey: async (apiKey: string) => {
    set({ isLoading: true, error: null })
    try {
      await cliAuthApi.update({ authProvider: 'openrouter', openRouterApiKey: apiKey })
      await cliAuthApi.invalidateCache()
      set({ authProvider: 'openrouter', openRouterApiKey: apiKey, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveOpenAIApiKey: async (apiKey: string) => {
    set({ isLoading: true, error: null })
    try {
      await cliAuthApi.update({ authProvider: 'openai', openAiApiKey: apiKey })
      await cliAuthApi.invalidateCache()
      set({ authProvider: 'openai', openAiApiKey: apiKey, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  saveOpenCodeApiKey: async (apiKey: string, modelName?: string) => {
    set({ isLoading: true, error: null })
    try {
      const updates: Record<string, unknown> = { authProvider: 'opencode', openCodeApiKey: apiKey }
      if (modelName) updates.openCodeModelName = modelName
      await cliAuthApi.update(updates as Partial<CliAuthConfig>)
      await cliAuthApi.invalidateCache()
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
      await cliAuthApi.update({ authProvider: 'local', localBaseUrl: baseUrl, localModelName: modelName })
      await cliAuthApi.invalidateCache()
      set({ authProvider: 'local', localBaseUrl: baseUrl, localModelName: modelName, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  clearAuth: async () => {
    set({ isLoading: true, error: null })
    try {
      await cliAuthApi.update({ authProvider: null })
      await cliAuthApi.invalidateCache()
      set({ authProvider: null, nvidiaApiKey: null, openRouterApiKey: null, openAiApiKey: null, openCodeApiKey: null, localBaseUrl: null, localModelName: null, isLoading: false })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
}))
