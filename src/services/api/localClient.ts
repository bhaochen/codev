import { getLocalBaseUrl } from '../../utils/auth.js'

type CachedLocalModel = {
  id: string
  contextWindow?: number
  maxTokens?: number
}

let cachedModels: CachedLocalModel[] | null = null
let fetchPromise: Promise<void> | null = null

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function nativeBaseUrl(url: string): string {
  let b = normalizeBaseUrl(url)
  if (b.endsWith('/v1')) b = b.slice(0, -3)
  return b
}

/**
 * GET {baseUrl}/props — Llama.cpp server metadata (n_ctx defaults, max tokens, vision).
 */
async function fetchServerProps(nativeBase: string): Promise<{ contextWindow?: number; maxTokens?: number }> {
  try {
    const res = await fetch(`${nativeBase}/props`, { signal: AbortSignal.timeout(10_000) })
    if (res.ok) {
      const data = (await res.json()) as any
      const settings = data?.default_generation_settings
      if (settings) {
        let cw: number | undefined
        let mt: number | undefined
        if (typeof settings.n_ctx === 'number') cw = settings.n_ctx
        if (typeof settings.max_tokens === 'number') mt = settings.max_tokens
        if (typeof settings.n_predict === 'number') mt = settings.n_predict
        if (mt === -1 && cw) mt = cw
        return { contextWindow: cw, maxTokens: mt }
      }
    }
  } catch {
    // /props not available
  }
  return {}
}

/**
 * GET {baseUrl}/models — Llama.cpp 原生模型列表（含 meta.n_ctx 上下文窗口等元数据）。
 */
async function fetchModelIdsAndContextWindows(
  nativeBase: string,
): Promise<{ modelIds: string[]; contextWindows: Map<string, { contextWindow?: number; maxTokens?: number }> }> {
  const contextWindows = new Map<string, { contextWindow?: number; maxTokens?: number }>()
  let modelIds: string[] = []

  try {
    const nativeUrl = `${nativeBase}/models`
    const res = await fetch(nativeUrl, { signal: AbortSignal.timeout(10_000) })
    if (res.ok) {
      const json = (await res.json()) as any
      if (json.data && Array.isArray(json.data)) {
        for (const entry of json.data as Array<{
          id: string
          meta?: { n_ctx?: number; n_ctx_train?: number }
          status?: { args?: string[]; preset?: string }
        }>) {
          modelIds.push(entry.id)
          let configuredCtx: number | undefined
          if (entry.status?.args) {
            const args = entry.status.args.join(' ')
            const m = args.match(/--ctx-size\s+(\d+)/)
            if (m) configuredCtx = Number(m[1])
          }
          const ctx = entry.meta?.n_ctx ?? configuredCtx ?? entry.meta?.n_ctx_train
          if (ctx) {
            contextWindows.set(entry.id, { contextWindow: ctx })
          }
        }
      }
    }
  } catch {
    // /models not available
  }

  return { modelIds, contextWindows }
}

async function doFetchModels(): Promise<void> {
  const baseUrl = getLocalBaseUrl()
  if (!baseUrl) return

  const nativeBase = nativeBaseUrl(baseUrl)

  const [modelResult, serverProps] = await Promise.all([
    fetchModelIdsAndContextWindows(nativeBase),
    fetchServerProps(nativeBase),
  ])

  let { modelIds, contextWindows } = modelResult
  const { contextWindow: serverCw, maxTokens: serverMt } = serverProps

  if (modelIds.length === 0) {
    modelIds = [...contextWindows.keys()]
  }

  cachedModels = modelIds.map(id => {
    const cw = contextWindows.get(id)
    return {
      id,
      contextWindow: serverCw ?? cw?.contextWindow,
      maxTokens: serverMt ?? cw?.maxTokens,
    }
  })
}

export async function fetchLocalModels(): Promise<string[]> {
  if (fetchPromise) return []
  fetchPromise = doFetchModels()
  await fetchPromise
  return cachedModels?.map(m => m.id) || []
}

export function getCachedLocalModels(): CachedLocalModel[] {
  return cachedModels || []
}

export function getLocalModelContextWindow(modelId: string): number | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.contextWindow
}

export function getLocalModelMaxTokens(modelId: string): number | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.maxTokens
}
