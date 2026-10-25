import type { ModelOption } from './modelOptions.js'
import { getOpenCodeApiKey, getOpenCodeModelName } from '../auth.js'
import { getOpencodeBaseUrl } from './providers.js'
import { recordProviderContextWindows } from './contextWindowStore.js'
import { recordModelVision, visionFromModelsDevEntry } from './visionCapability.js'

// Note: Model catalog fetcher still uses /zen/v1/models (still returns 200 upstream).
// The free-tier inference endpoint moved to /inference/v1 (handled in OpenCodeAdapter).
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
  promptLimit?: number
  maxTokens?: number
  reasoningOptions?: string[]
}

/**
 * Model-native context windows, keyed by normalized base model id.
 *
 * The api.json mirror carries EVERY provider section (opencode, nvidia,
 * openrouter, …), and the same model body is often listed several times with
 * different deployment caps — e.g. opencode's free tier publishes
 * `deepseek-v4.1-flash-free` at 200k while the nvidia section lists the same
 * `deepseek-v4.1-flash` body at 1M. A deployment can only SHRINK what the
 * model body supports, never exceed it, so the max across all sections is
 * the model's native window ("adapt to the model itself, not the tier").
 */
let nativeWindows: Map<string, number> | null = null

let cachedModels: CachedOpencodeModel[] | null = null
let fetchPromise: Promise<void> | null = null

/** Normalize a model id to its base identity for cross-section matching. */
export function normalizeModelBaseId(id: string): string {
  let s = id.trim().toLowerCase()
  // OpenRouter channel variants (':free', ':nitro', …) and org prefixes.
  const colon = s.indexOf(':')
  if (colon !== -1) s = s.slice(0, colon)
  const slash = s.lastIndexOf('/')
  if (slash !== -1) s = s.slice(slash + 1)
  // Free/tier suffixes (opencode '-free', common '-nitro').
  s = s.replace(/-(free|nitro|floor|online|extended)$/, '')
  return s
}

function entryEffectiveWindow(entry: {
  contextWindow?: number
  promptLimit?: number
}): number | undefined {
  return entry.contextWindow && entry.promptLimit
    ? Math.min(entry.contextWindow, entry.promptLimit)
    : entry.contextWindow
}

/**
 * Build the base-model → native-window index from a full models.dev mirror
 * document (any provider section with a `models` map). Pure — exported for
 * tests.
 */
export function deriveNativeWindows(doc: unknown): Map<string, number> {
  const index = new Map<string, number>()
  const sections = (doc as Record<string, { models?: Record<string, unknown> }>) ?? {}
  for (const section of Object.values(sections)) {
    const models = section?.models
    if (!models || typeof models !== 'object') continue
    for (const [id, raw] of Object.entries(models)) {
      const limit = (raw as { limit?: { context?: number; input?: number } })?.limit
      if (!limit) continue
      const effective = limit.context && limit.input
        ? Math.min(limit.context, limit.input)
        : limit.context
      if (!effective || effective <= 0) continue
      const base = normalizeModelBaseId(id)
      const prev = index.get(base)
      if (prev === undefined || effective > prev) index.set(base, effective)
    }
  }
  return index
}

/**
 * The model body's native context window (max across all provider sections
 * that list the same base model), or undefined when unknown.
 */
export function getOpencodeModelNativeWindow(modelId: string): number | undefined {
  if (!nativeWindows) return undefined
  return nativeWindows.get(normalizeModelBaseId(modelId))
}

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

        const vision = visionFromModelsDevEntry(config)
        if (vision !== undefined) {
          recordModelVision('opencode', modelId, vision)
        }

        modelList.push({
          id: modelId,
          name: config.name || modelId,
          isFree: isFreeModel,
          contextWindow: config.limit?.context,
          promptLimit: config.limit?.input,
          maxTokens: config.limit?.output,
          reasoningOptions,
        })
      }

      cachedModels = modelList
      nativeWindows = deriveNativeWindows(data)
      recordProviderContextWindows(
        'opencode',
        modelList.flatMap(model =>
          model.contextWindow
            ? [{ id: model.id, contextWindow: model.contextWindow, promptLimit: model.promptLimit }]
            : [],
        ),
      )
    } catch (error) {
      console.error('[opencodeModels] Error in dynamic TUI flow simulation:', error)
      if (!cachedModels) {
        // 网络极端崩溃情况下的硬编码兜底保护
        cachedModels = [
          { id: 'big-pickle', name: 'Big Pickle', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
          { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
          { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super Free', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
          { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', isFree: true, contextWindow: 1_000_000, maxTokens: 128_000 },
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
  return model?.contextWindow && model.promptLimit
    ? Math.min(model.contextWindow, model.promptLimit)
    : model?.contextWindow
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