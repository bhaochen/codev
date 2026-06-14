// desktop/src/stores/providerStore.ts

import { create } from 'zustand'
import { providersApi } from '../api/providers'
import { useChatStore } from './chatStore'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useSettingsStore } from './settingsStore'
import { OFFICIAL_DEFAULT_MODEL_ID } from '../constants/modelCatalog'
import { saveTuiConfigPatch, clearConfigCache } from '../api/config'
import type {
  SavedProvider,
  CreateProviderInput,
  UpdateProviderInput,
  TestProviderConfigInput,
  ProviderTestResult,
} from '../types/provider'
import type { ProviderPreset } from '../types/providerPreset'
import type { RuntimeSelection } from '../types/runtime'

type ProviderStore = {
  providers: SavedProvider[]
  activeId: string | null
  hasLoadedProviders: boolean
  presets: ProviderPreset[]
  isLoading: boolean
  isPresetsLoading: boolean
  error: string | null

  fetchProviders: () => Promise<void>
  fetchPresets: () => Promise<void>
  createProvider: (input: CreateProviderInput) => Promise<SavedProvider>
  updateProvider: (id: string, input: UpdateProviderInput) => Promise<SavedProvider>
  deleteProvider: (id: string) => Promise<void>
  activateProvider: (id: string) => Promise<void>
  activateOfficial: () => Promise<void>
  testProvider: (id: string, overrides?: { baseUrl?: string; modelId?: string; apiFormat?: string; authStrategy?: string }) => Promise<ProviderTestResult>
  testConfig: (input: TestProviderConfigInput) => Promise<ProviderTestResult>
}

function providerModelIds(provider: SavedProvider): Set<string> {
  return new Set(
    Object.values(provider.models)
      .map((modelId) => modelId.trim())
      .filter(Boolean),
  )
}

/** Map a sidecar SavedProvider to TUI ~/.claude.json authProvider fields */
type TuiProviderMapping = { authProvider: string; apiKeyField: string; apiKey?: string } | null
function mapSidecarToTuiProvider(provider: SavedProvider): TuiProviderMapping {
  const apiFormat = provider.apiFormat || 'anthropic'
  const baseUrl = (provider.baseUrl || '').toLowerCase()
  const name = (provider.name || '').toLowerCase()

  // Detect local provider (Ollama, LM Studio, vLLM, etc.)
  const isOpenAiFormat = apiFormat === 'openai_chat' || apiFormat === 'openai_responses'
  if (
    isOpenAiFormat &&
    (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0') ||
     name.includes('local') || name.includes('ollama'))
  ) {
    return {
      authProvider: 'local',
      apiKeyField: 'localBaseUrl',
      // TUI's local config expects localBaseUrl + localModelName
      apiKey: provider.baseUrl,
    }
  }

  switch (apiFormat) {
    case 'anthropic':
      return { authProvider: 'anthropic', apiKeyField: 'anthropicApiKey', apiKey: provider.apiKey }
    case 'openai_chat':
    case 'openai_responses': {
      if (baseUrl.includes('nvidia') || name.includes('nvidia')) {
        return { authProvider: 'nvidia', apiKeyField: 'nvidiaApiKey', apiKey: provider.apiKey }
      }
      if (baseUrl.includes('openrouter') || name.includes('openrouter')) {
        return { authProvider: 'openrouter', apiKeyField: 'openRouterApiKey', apiKey: provider.apiKey }
      }
      if (baseUrl.includes('opencode') || name.includes('opencode')) {
        return { authProvider: 'opencode', apiKeyField: 'openCodeApiKey', apiKey: provider.apiKey }
      }
      // Generic OpenAI-compatible
      return { authProvider: 'openai', apiKeyField: 'openAiApiKey', apiKey: provider.apiKey }
    }
    default:
      return null
  }
}

function resolveRuntimeRefreshSelection(
  provider: SavedProvider,
  activeId: string | null,
  currentSelection: RuntimeSelection | undefined,
): RuntimeSelection | null {
  if (currentSelection?.providerId === provider.id) {
    const modelIds = providerModelIds(provider)
    return {
      providerId: provider.id,
      modelId: modelIds.has(currentSelection.modelId)
        ? currentSelection.modelId
        : provider.models.main,
    }
  }

  if (!currentSelection && activeId === provider.id) {
    return {
      providerId: provider.id,
      modelId: provider.models.main,
    }
  }

  return null
}

function refreshConnectedSessionsForProvider(provider: SavedProvider, activeId: string | null) {
  const chatStore = useChatStore.getState()
  const runtimeStore = useSessionRuntimeStore.getState()

  for (const [sessionId, session] of Object.entries(chatStore.sessions)) {
    if (session.connectionState !== 'connected' || session.chatState !== 'idle') {
      continue
    }

    const selection = resolveRuntimeRefreshSelection(
      provider,
      activeId,
      runtimeStore.selections[sessionId],
    )
    if (!selection) continue

    runtimeStore.setSelection(sessionId, selection)
    chatStore.setSessionRuntime(sessionId, selection)
  }
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
  providers: [],
  activeId: null,
  hasLoadedProviders: false,
  presets: [],
  isLoading: false,
  isPresetsLoading: false,
  error: null,

  fetchProviders: async () => {
    set({ isLoading: true, error: null })
    try {
      const { providers, activeId } = await providersApi.list()
      set({ providers, activeId, hasLoadedProviders: true, isLoading: false })
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  fetchPresets: async () => {
    set({ isPresetsLoading: true, error: null })
    try {
      const { presets } = await providersApi.presets()
      set({ presets, isPresetsLoading: false })
    } catch (err) {
      set({ isPresetsLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  createProvider: async (input) => {
    const { provider } = await providersApi.create(input)
    await get().fetchProviders()
    return provider
  },

  updateProvider: async (id, input) => {
    const { provider } = await providersApi.update(id, input)
    await get().fetchProviders()
    refreshConnectedSessionsForProvider(provider, get().activeId)
    return provider
  },

  deleteProvider: async (id) => {
    await providersApi.delete(id)
    await get().fetchProviders()
  },

  activateProvider: async (id) => {
    await providersApi.activate(id)
    await get().fetchProviders()

    const provider = get().providers.find((p) => p.id === id)
    if (!provider) return

    // Derive CLI authProvider from the sidecar provider
    const tuiProvider = mapSidecarToTuiProvider(provider)
    const authProvider = tuiProvider?.authProvider ?? null
    const cliProviderId = authProvider ? `cli-${authProvider}` : null
    const CLI_PROVIDER_NAMES: Record<string, string> = {
      nvidia: 'NVIDIA',
      openrouter: 'OpenRouter',
      opencode: 'OpenCode Zen',
      openai: 'OpenAI',
      local: 'Local',
      anthropic: 'Anthropic',
    }
    const cliProviderName = authProvider ? (CLI_PROVIDER_NAMES[authProvider] ?? authProvider) : null

    // Optimistically update settingsStore so the UI reflects the change immediately
    const settings = useSettingsStore.getState()
    const cliModels = Object.values(provider.models).filter(Boolean).map(id => ({
      id, name: id, description: '', context: '',
    }))
    settings.setActiveProvider(cliProviderId, cliProviderName, cliModels)

    // Sync provider info to ~/.claude.json
    const patch: Record<string, unknown> = {}
    if (authProvider) patch.authProvider = authProvider
    if (tuiProvider?.authProvider === 'local') {
      patch.localBaseUrl = provider.baseUrl
      patch.localModelName = provider.models.main
    } else if (tuiProvider?.apiKey) {
      patch[tuiProvider.apiKeyField] = tuiProvider.apiKey
    }
    patch.model = provider.models.main

    await saveTuiConfigPatch(patch)
    clearConfigCache()
    await settings.syncFromConfig()
  },

  activateOfficial: async () => {
    await providersApi.activateOfficial()
    await get().fetchProviders()
    // 同步回 Anthropic first-party
    await saveTuiConfigPatch({ authProvider: 'anthropic' })
    clearConfigCache()
    const settings = useSettingsStore.getState()
    await settings.setModel(OFFICIAL_DEFAULT_MODEL_ID)
    await settings.fetchAll()
  },

  testProvider: async (id, overrides?) => {
    const { result } = await providersApi.test(id, overrides)
    return result
  },

  testConfig: async (input) => {
    const { result } = await providersApi.testConfig(input)
    return result
  },
}))
