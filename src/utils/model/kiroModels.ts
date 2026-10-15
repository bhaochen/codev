import type { ModelOption } from './modelOptions.js'
import { getValidKiroAccessToken, getKiroProfileArn, getKiroRegion } from '../auth.js'
import { getKiroBaseUrl } from './providers.js'
import { recordProviderContextWindows } from './contextWindowStore.js'
import { recordModelVision, visionFromModelsDevEntry } from './visionCapability.js'

const CODEWHISPERER_BASE_URL = 'https://codewhisperer.us-east-1.amazonaws.com'

type CachedKiroModel = {
  id: string
  name?: string
  isFree: boolean
  contextWindow?: number
  promptLimit?: number
  maxTokens?: number
  reasoningOptions?: string[]
}

let cachedModels: CachedKiroModel[] | null = null
let fetchPromise: Promise<void> | null = null

/**
 * Fetch and cache the Kiro model catalog from CodeWhisperer API.
 * Called at startup (setup.ts) and on-demand (model picker, login).
 * Populates the in-memory cache used by all metadata helpers.
 */
export async function fetchKiroModels(): Promise<void> {
  if (fetchPromise) return

  fetchPromise = (async () => {
    try {
      const accessToken = await getValidKiroAccessToken()
      const profileArn = getKiroProfileArn()
      const region = getKiroRegion() || 'us-east-1'

      if (!accessToken || !profileArn) {
        console.error('[kiroModels] Missing access token or profile ARN')
        return
      }

      const endpoint = `https://codewhisperer.${region}.amazonaws.com`
      const target = 'AmazonCodeWhispererService.ListAvailableModels'

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.0',
          'x-amz-target': target,
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          origin: 'AI_EDITOR',
          profileArn,
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        console.error(`[kiroModels] Failed to list models: ${error}`)
        return
      }

      const data = await response.json()
      const models = Array.isArray(data?.models) ? data.models : []

      const modelList: CachedKiroModel[] = []

      for (const m of models) {
        // Kiro models from CodeWhisperer are free (included with AWS Builder ID)
        const isFreeModel = true
        const reasoningOptions = m.reasoning_options?.find(
          (o: any) => o.type === 'effort',
        )?.values

        const vision = visionFromModelsDevEntry(m)
        if (vision !== undefined) {
          recordModelVision('kiro', m.modelId, vision)
        }

        modelList.push({
          id: m.modelId,
          name: m.modelName || m.modelId,
          isFree: isFreeModel,
          contextWindow: m.tokenLimits?.maxInputTokens,
          promptLimit: m.tokenLimits?.maxInputTokens,
          maxTokens: m.tokenLimits?.maxOutputTokens,
          reasoningOptions,
        })
      }

      cachedModels = modelList
      recordProviderContextWindows(
        'kiro',
        modelList.flatMap(model =>
          model.contextWindow
            ? [{ id: model.id, contextWindow: model.contextWindow, promptLimit: model.promptLimit }]
            : [],
        ),
      )
    } catch (error) {
      console.error('[kiroModels] Error fetching Kiro models:', error)
      if (!cachedModels) {
        // Fallback models if network fails (IDs match CodeWhisperer ListAvailableModels)
        cachedModels = [
          { id: 'auto', name: 'Auto', isFree: true, contextWindow: 1_000_000, maxTokens: 64_000 },
          { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', isFree: true, contextWindow: 200_000, maxTokens: 64_000 },
        ]
      }
    } finally {
      fetchPromise = null
    }
  })()

  await fetchPromise
}

/**
 * Get the cached Kiro models.
 * Returns empty array if not yet fetched.
 */
export function getCachedKiroModels(): CachedKiroModel[] {
  return cachedModels || []
}

/**
 * 目录驱动的显示名：有缓存命中即返回目录 name，无硬编码 ID 分支；
 * 未命中返回 undefined，调用方自行回退原始 ID。
 */
export function getKiroModelDisplayName(modelId: string): string | undefined {
  if (!cachedModels) return undefined
  return cachedModels.find(m => m.id === modelId)?.name
}

export function getKiroModelContextWindow(modelId: string): number | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.contextWindow && model.promptLimit
    ? Math.min(model.contextWindow, model.promptLimit)
    : model?.contextWindow
}

export function getKiroModelMaxTokens(modelId: string): number | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.maxTokens
}

export function getKiroModelReasoningOptions(modelId: string): string[] | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.reasoningOptions
}