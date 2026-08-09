/**
 * OpenAI 兼容端点模型列表获取（telegram /connect 流程使用）。
 */

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function modelsListUrlFromOpenAIBase(base: string): string {
  const b = normalizeBaseUrl(base)
  if (b.endsWith('/v1')) {
    return `${b}/models`
  }
  return `${b}/v1/models`
}

function parseOpenAIStyleModelList(json: unknown): string[] {
  if (!json || typeof json !== 'object') {
    return []
  }
  const o = json as Record<string, unknown>
  const data = o.data
  if (Array.isArray(data)) {
    const ids: string[] = []
    for (const item of data) {
      if (
        item &&
        typeof item === 'object' &&
        'id' in item &&
        typeof (item as { id: unknown }).id === 'string'
      ) {
        ids.push((item as { id: string }).id)
      }
    }
    return [...new Set(ids.filter(Boolean))]
  }
  const models = o.models
  if (Array.isArray(models)) {
    const ids: string[] = []
    for (const item of models) {
      if (typeof item === 'string') {
        ids.push(item)
      } else if (
        item &&
        typeof item === 'object' &&
        'id' in item &&
        typeof (item as { id: unknown }).id === 'string'
      ) {
        ids.push((item as { id: string }).id)
      }
    }
    return [...new Set(ids.filter(Boolean))]
  }
  return []
}

/**
 * GET /v1/models（OpenAI 兼容格式）。
 */
export async function fetchOpenAICompatibleModelIds(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  const url = modelsListUrlFromOpenAIBase(baseUrl)
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `OpenAI-compatible /v1/models failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
    )
  }
  const json: unknown = await res.json()
  return parseOpenAIStyleModelList(json)
}

/**
 * GET /v1/models（Anthropic API 格式）。
 */
export async function fetchAnthropicCompatibleModelIds(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  let root = baseUrl.replace(/\/$/, '')
  if (root.endsWith('/v1')) {
    root = root.slice(0, -3)
  }
  const url = `${root}/v1/models`
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  if (apiKey) {
    headers['x-api-key'] = apiKey
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Anthropic /v1/models failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
    )
  }
  const json: unknown = await res.json()
  return parseOpenAIStyleModelList(json)
}