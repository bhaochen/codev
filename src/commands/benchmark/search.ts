/**
 * /benchmark —— search_web / visit_web 工具实现。
 *
 * 与 src/tools/WebSearchTool/WebSearchTool.ts 同源：
 * TAVILY_API_KEY 存在走 Tavily，否则走本地 SearXNG。visit_web 直接 fetch 页面。
 */

export type SearchHit = {
  title: string
  url: string
  snippet?: string
}

/** 通用搜索（最多 5 条，深度研究不需要铺满 10 条，省 context） */
export async function webSearch(query: string): Promise<SearchHit[]> {
  if (process.env.TAVILY_API_KEY) {
    return searchTavily(query)
  }
  return searchSearXNG(query)
}

async function searchSearXNG(query: string): Promise<SearchHit[]> {
  const baseUrl = process.env.SEARXNG_BASE_URL || 'http://localhost:8080'
  const url = new URL('/search', baseUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodevBenchmark/1.0)',
        Accept: 'application/json',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> }
    return (data.results ?? [])
      .slice(0, 5)
      .map(r => ({
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        snippet: r.content ? String(r.content) : undefined,
      }))
      .filter(h => h.url)
  } finally {
    clearTimeout(timer)
  }
}

async function searchTavily(query: string): Promise<SearchHit[]> {
  const { tavily } = await import('@tavily/core')
  const client = tavily({ apiKey: process.env.TAVILY_API_KEY })
  const response = await client.search(query, {
    maxResults: 5,
    searchDepth: 'basic',
    topic: 'general',
  })
  return (response.results ?? [])
    .map(r => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      snippet: r.content ? String(r.content) : undefined,
    }))
    .filter(h => h.url)
}

/** 抓取并清洗页面正文（用于 visit_web）。失败返回错误描述，不抛错。 */
export async function visitPage(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  const minusTags = (html: string): string => {
    if (html.length > 200_000) html = html.slice(0, 200_000)
    // 尽量去掉 script/style/nav/footer 噪音
    html = html
      .replace(/<(script|style|noscript|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
    // 提取 <main> 或 <article> 内容，拿不到就用整个 body
    const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0]
    const article = html.match(/<article[\s\S]*?<\/article>/i)?.[0]
    const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0]
    html = main ?? article ?? body ?? html
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>|<\/div>|<\/h[1-6]>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodevBenchmark/1.0)',
      },
    })
    if (!res.ok) return `Error: HTTP ${res.status} while fetching ${url}`
    const text = await res.text()
    const clean = minusTags(text)
    if (!clean) return `Error: no readable content at ${url}`
    return clean.slice(0, 6000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error: ${message} while fetching ${url}`
  } finally {
    clearTimeout(timer)
  }
}

/** 把搜索结果格式化成 agent transcript 里的 tool result 文本 */
export function formatHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `No results for: ${query}`
  const lines = hits.map(
    (h, i) =>
      `${i + 1}. ${h.title}\n${h.url}${h.snippet ? `\n${h.snippet.slice(0, 400)}` : ''}`,
  )
  return `Search results for "${query}":\n\n${lines.join('\n\n')}`
}