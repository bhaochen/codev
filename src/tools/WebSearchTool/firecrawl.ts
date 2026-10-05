export type FirecrawlSearchHit = {
  title: string
  url: string
  snippet?: string
  image?: string
}

type FirecrawlResult = {
  url?: unknown
  title?: unknown
  description?: unknown
  markdown?: unknown
  metadata?: {
    title?: unknown
    description?: unknown
    sourceURL?: unknown
    url?: unknown
    image?: unknown
    ogImage?: unknown
  }
}

const DEFAULT_API_URL = 'https://api.firecrawl.dev'
const SEARCH_TIMEOUT_MS = 30_000

export function hasFirecrawlConfig(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.FIRECRAWL_API_KEY?.trim())
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeHit(value: unknown): FirecrawlSearchHit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const result = value as FirecrawlResult
  const url =
    asNonEmptyString(result.url) ??
    asNonEmptyString(result.metadata?.sourceURL) ??
    asNonEmptyString(result.metadata?.url)
  if (!url) return null

  const title =
    asNonEmptyString(result.title) ??
    asNonEmptyString(result.metadata?.title) ??
    url
  const snippet =
    asNonEmptyString(result.description) ??
    asNonEmptyString(result.metadata?.description) ??
    asNonEmptyString(result.markdown)
  const image =
    asNonEmptyString(result.metadata?.image) ??
    asNonEmptyString(result.metadata?.ogImage)
  return {
    title: title.replace(/\s+/g, ' ').slice(0, 800),
    url,
    ...(snippet && { snippet: snippet.replace(/\s+/g, ' ').slice(0, 4_000) }),
    ...(image && { image }),
  }
}

export async function searchWithFirecrawl(
  query: string,
  options: {
    allowedDomains?: string[]
    blockedDomains?: string[]
    signal?: AbortSignal
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<FirecrawlSearchHit[]> {
  const env = options.env ?? process.env
  const apiKey = env.FIRECRAWL_API_KEY?.trim()
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY is not configured')

  const baseUrl = (
    env.FIRECRAWL_API_URL?.trim() || DEFAULT_API_URL
  ).replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  const abortExternal = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abortExternal()
  else options.signal?.addEventListener('abort', abortExternal, { once: true })

  try {
    const response = await fetch(`${baseUrl}/v2/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        sources: ['web'],
        limit: 10,
        ...(options.allowedDomains?.length && {
          includeDomains: options.allowedDomains,
        }),
        ...(options.blockedDomains?.length && {
          excludeDomains: options.blockedDomains,
        }),
        scrapeOptions: {
          formats: ['markdown'],
          onlyMainContent: true,
          removeBase64Images: true,
        },
      }),
      signal: controller.signal,
    })
    const responseText = await response.text()
    let payload: {
      success?: boolean
      data?: unknown
      error?: unknown
      message?: unknown
    }
    try {
      payload = JSON.parse(responseText) as typeof payload
    } catch {
      throw new Error(
        `Firecrawl returned invalid JSON (HTTP ${response.status})`,
      )
    }
    if (!response.ok || payload.success === false) {
      const detail =
        asNonEmptyString(payload.error) ??
        asNonEmptyString(payload.message) ??
        `${response.status} ${response.statusText}`
      throw new Error(`Firecrawl search failed: ${detail}`)
    }

    const data = payload.data
    const records = Array.isArray(data)
      ? data
      : typeof data === 'object' && data !== null
        ? (data as { web?: unknown }).web
        : undefined
    if (!Array.isArray(records)) return []
    return records
      .map(normalizeHit)
      .filter((hit): hit is FirecrawlSearchHit => hit !== null)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortExternal)
  }
}
