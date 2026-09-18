import type { ModelOption } from './modelOptions.js'
import { getOpenCodeApiKey, getOpenCodeModelName } from '../auth.js'
import { getOpencodeBaseUrl } from './providers.js'

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
// 模型目录源与官方 opencode 对齐：优先自建镜像，失败回退上游 models.dev
// （对标 opencode packages/core/src/models-dev.ts: `Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"`）
const MODELS_META_PRIMARY_URL =
  process.env.OPENCODE_MODELS_URL || 'https://models.opencode.ai/api.json'
const MODELS_META_FALLBACK_URL = 'https://models.dev/api.json'

type CachedOpencodeModel = {
  id: string
  name?: string
  isFree: boolean
  contextWindow?: number
  maxTokens?: number
  reasoningOptions?: string[]
}

let cachedModels: CachedOpencodeModel[] | null = null
let fetchPromise: Promise<void> | null = null

/**
 * Fetch and cache the OpenCode model catalog.
 * Called at startup (setup.ts) and on-demand (model picker, login).
 * Populates the in-memory cache used by all metadata helpers.
 */
export async function fetchOpencodeModels(): Promise<void> {
  if (fetchPromise) return

  fetchPromise = (async () => {
    try {
      // -----------------------------------------------------------------
      // 请求模型目录元数据，为精准剔除下架模型、识别免费模型做铺垫。
      // UA 必须对应本机安装的 OpenCode 版本，不能拿 GitHub 最新版本冒充。
      // 主源 models.opencode.ai（官方行为），失败回退 models.dev
      // -----------------------------------------------------------------
      const metaHeaders = {
        'User-Agent': getOpencodeUserAgent(),
        'Accept-Encoding': 'gzip, deflate, br',
      }
      let res = await fetch(MODELS_META_PRIMARY_URL, { headers: metaHeaders }).catch(() => null)
      if (!res?.ok) {
        console.error(
          `[opencodeModels] Primary models source failed (${res ? `${res.status} ${res.statusText}` : 'network error'}), falling back to ${MODELS_META_FALLBACK_URL}`,
        )
        res = await fetch(MODELS_META_FALLBACK_URL, { headers: metaHeaders }).catch(() => null)
      }

      if (!res?.ok) {
        console.error(`[opencodeModels] Failed to fetch models meta: ${res ? `${res.status} ${res.statusText}` : 'network error'}`)
        return
      }

      const data = await res.json() as any
      // -----------------------------------------------------------------
      // 摒弃死板的硬编码 Set，改用云端 cost 策略实时判定免费模型
      // -----------------------------------------------------------------
      const opencodeModels = data?.opencode?.models || {}
      const modelList: CachedOpencodeModel[] = []

      for (const [modelId, config] of Object.entries(opencodeModels) as [string, any][]) {
        // 过滤掉已被官方废弃下架的模型
        if (config.status === 'deprecated') {
          continue
        }

        // 动态检测真正零成本的活体模型
        const isFreeModel = config.cost?.input === 0 && config.cost?.output === 0
        const reasoningOptions = config.reasoning_options?.find(
          (o: any) => o.type === 'effort',
        )?.values

        modelList.push({
          id: modelId,
          name: config.name || modelId,
          isFree: isFreeModel,
          contextWindow: config.limit?.context,
          maxTokens: config.limit?.output,
          reasoningOptions,
        })
      }

      cachedModels = modelList
    } catch (error) {
      console.error('[opencodeModels] Error in dynamic TUI flow simulation:', error)
      if (!cachedModels) {
        // 网络极端崩溃情况下的硬编码兜底保护
        cachedModels = [
          { id: 'big-pickle', name: 'Big Pickle', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
          { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
          { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super Free', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
        ]
      }
    } finally {
      fetchPromise = null
    }
  })()

  await fetchPromise
}

/**
 * Get the cached Opencode models.
 * Returns empty array if not yet fetched.
 */
export function getCachedOpencodeModels(): CachedOpencodeModel[] {
  return cachedModels || []
}

/**
 * 目录驱动的显示名：有缓存命中即返回目录 name，无硬编码 ID 分支；
 * 未命中返回 undefined，调用方自行回退原始 ID。
 */
export function getOpencodeModelDisplayName(modelId: string): string | undefined {
  if (!cachedModels) return undefined
  return cachedModels.find(m => m.id === modelId)?.name
}

export function getOpencodeModelContextWindow(modelId: string): number | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.contextWindow
}

export function getOpencodeModelMaxTokens(modelId: string): number | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.maxTokens
}

export function getOpencodeModelReasoningOptions(modelId: string): string[] | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.reasoningOptions
}

function getOpencodeUserAgent(): string {
  const version = process.env.OPENCODE_VERSION || '0.100.0'
  return `OpenCode/${version} (codev)`
}