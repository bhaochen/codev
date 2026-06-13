import { api } from './client'

type AuthProvider = 'anthropic' | 'openai' | 'openrouter' | 'local' | 'opencode' | 'nvidia'

type CliAuthConfig = {
  authProvider: AuthProvider | null
  nvidiaApiKey?: string
  openRouterApiKey?: string
  openAiApiKey?: string
  openAiAccessToken?: string
  openCodeApiKey?: string
  openCodeModelName?: string
  localBaseUrl?: string
  localModelName?: string
}

export type { AuthProvider, CliAuthConfig }

export const cliAuthApi = {
  get(): Promise<CliAuthConfig> {
    return api.get<CliAuthConfig>('/api/cli-auth')
  },

  update(config: Partial<CliAuthConfig>): Promise<{ ok: true }> {
    return api.put<{ ok: true }>('/api/cli-auth', config)
  },

  invalidateCache(): Promise<{ ok: true }> {
    return api.post<{ ok: true }>('/api/cli-auth/invalidate', {})
  },
}
