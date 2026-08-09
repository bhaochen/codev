import { getGlobalConfig, type GlobalConfig } from '../../utils/config.js'

const COPILOT_API_BASE = 'https://api.githubcopilot.com'
const MODELS_DEV_URL = 'https://models.dev/api.json'

/**
 * GlobalConfig 未声明 connectedProviders 字段（telegram 流程以「多余字段」写入）；
 * 此处给出读取侧的最小形状，避免依赖不存在的 ConnectedProviderInfo 类型。
 */
export type CopilotProviderInfo = {
  oauthToken?: string
  connectedAt?: string
}

export type CopilotModelInfo = {
  id: string
  label: string
  description: string
  supportedEndpoints?: string[]
}

const FALLBACK_COPILOT_MODELS: CopilotModelInfo[] = [
  { id: 'copilot:claude-sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'Claude Sonnet 4.6 via Copilot' },
  { id: 'copilot:claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'Claude Sonnet 4.5 via Copilot' },
  { id: 'copilot:claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Claude Sonnet 4 via Copilot' },
  { id: 'copilot:claude-opus-4.6', label: 'Claude Opus 4.6', description: 'Claude Opus 4.6 via Copilot' },
  { id: 'copilot:claude-opus-4.5', label: 'Claude Opus 4.5', description: 'Claude Opus 4.5 via Copilot' },
  { id: 'copilot:claude-opus-41', label: 'Claude Opus 4.1', description: 'Claude Opus 4.1 via Copilot' },
  { id: 'copilot:claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'Claude Haiku 4.5 via Copilot' },
  { id: 'copilot:gpt-5.4', label: 'GPT-5.4', description: 'OpenAI GPT-5.4 via Copilot' },
  { id: 'copilot:gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI GPT-5.4 mini via Copilot' },
  { id: 'copilot:gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'OpenAI GPT-5.3-Codex via Copilot' },
  { id: 'copilot:gpt-5.2-codex', label: 'GPT-5.2-Codex', description: 'OpenAI GPT-5.2-Codex via Copilot' },
  { id: 'copilot:gpt-5.2', label: 'GPT-5.2', description: 'OpenAI GPT-5.2 via Copilot' },
  { id: 'copilot:gpt-5.1', label: 'GPT-5.1', description: 'OpenAI GPT-5.1 via Copilot' },
  { id: 'copilot:gpt-5.1-codex', label: 'GPT-5.1-Codex', description: 'OpenAI GPT-5.1-Codex via Copilot' },
  { id: 'copilot:gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-mini', description: 'OpenAI GPT-5.1-Codex-mini via Copilot' },
  { id: 'copilot:gpt-5.1-codex-max', label: 'GPT-5.1-Codex-max', description: 'OpenAI GPT-5.1-Codex-max via Copilot' },
  { id: 'copilot:gpt-5', label: 'GPT-5', description: 'OpenAI GPT-5 via Copilot' },
  { id: 'copilot:gpt-5-mini', label: 'GPT-5-mini', description: 'OpenAI GPT-5-mini via Copilot' },
  { id: 'copilot:gpt-4.1', label: 'GPT-4.1', description: 'OpenAI GPT-4.1 via Copilot' },
  { id: 'copilot:gpt-4o', label: 'GPT-4o', description: 'OpenAI GPT-4o via Copilot' },
  { id: 'copilot:gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', description: 'Google Gemini 3.1 Pro via Copilot' },
  { id: 'copilot:gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', description: 'Google Gemini 3 Pro via Copilot' },
  { id: 'copilot:gemini-3-flash-preview', label: 'Gemini 3 Flash', description: 'Google Gemini 3 Flash via Copilot' },
  { id: 'copilot:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Google Gemini 2.5 Pro via Copilot' },
  { id: 'copilot:grok-code-fast-1', label: 'Grok Code Fast 1', description: 'xAI Grok Code Fast 1 via Copilot' },
]

export { FALLBACK_COPILOT_MODELS as COPILOT_MODELS }

type CopilotApiModel = {
  id: string
  name?: string
  model_picker_enabled?: boolean
  policy?: { state?: string }
  supported_endpoints?: string[]
}

export function getCopilotProvider(): CopilotProviderInfo | undefined {
  const config = getGlobalConfig() as GlobalConfig & {
    connectedProviders?: Record<string, CopilotProviderInfo | undefined>
  }
  return config.connectedProviders?.['github-copilot']
}

export async function fetchCopilotModelsFromApi(): Promise<CopilotModelInfo[] | null> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) return null

  const response = await fetch(`${COPILOT_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${provider.oauthToken}`,
      'User-Agent': 'claude-code/2.1.88',
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'user',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Copilot models API failed (${response.status})`)
  }

  const data = (await response.json()) as {
    data?: CopilotApiModel[]
  }
  if (!Array.isArray(data.data) || data.data.length === 0) {
    return null
  }

  const models = data.data
    .filter(model => model.model_picker_enabled !== false)
    .filter(model => model.policy?.state !== 'disabled')
    .map(
      (model): CopilotModelInfo => ({
        id: `copilot:${model.id}`,
        label: model.name || model.id,
        description: `${model.name || model.id} via Copilot`,
        supportedEndpoints: model.supported_endpoints,
      }),
    )

  return models.length > 0 ? models : null
}

export async function fetchCopilotModelsFromModelsDev(): Promise<CopilotModelInfo[]> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return FALLBACK_COPILOT_MODELS

    const data = (await response.json()) as Record<
      string,
      { models?: Record<string, { name?: string }> }
    >
    const copilotProvider = data['github-copilot']
    if (!copilotProvider?.models) return FALLBACK_COPILOT_MODELS

    const models: CopilotModelInfo[] = Object.entries(
      copilotProvider.models,
    ).map(([modelId, info]) => ({
      id: `copilot:${modelId}`,
      label: info.name || modelId,
      description: `${info.name || modelId} via Copilot`,
    }))

    return models.length > 0 ? models : FALLBACK_COPILOT_MODELS
  } catch {
    return FALLBACK_COPILOT_MODELS
  }
}

export async function fetchCopilotModels(): Promise<CopilotModelInfo[]> {
  try {
    const apiModels = await fetchCopilotModelsFromApi()
    if (apiModels && apiModels.length > 0) {
      return apiModels
    }
  } catch {}

  return fetchCopilotModelsFromModelsDev()
}