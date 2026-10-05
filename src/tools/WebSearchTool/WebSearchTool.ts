import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import { tavily } from '@tavily/core'
import { hasFirecrawlConfig, searchWithFirecrawl } from './firecrawl.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(2).describe('The search query to use'),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('Limit results to these domain names'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe('Exclude results from these domain names'),
    search_images: z.boolean().optional().describe(
      'IMPORTANT: Set to true when the user asks to see/show/find photos, images, pictures, or ' +
      'visual references (e.g. "show me photos of...", "find pictures of...", "look up images of..."). ' +
      'When true, results contain direct image URLs (.jpg/.png/.gif) for citation or image-aware workflows. ' +
      'Without this flag, image URLs are NOT available in results.'
    ),
  }),
)

type Input = z.infer<ReturnType<typeof inputSchema>>

const searchResultSchema = lazySchema(() => {
  const searchHitSchema = z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string().optional(),
    image: z.string().optional(),
  })

  return z.object({
    tool_use_id: z.string(),
    content: z.array(searchHitSchema),
  })
})

export type SearchResult = z.infer<ReturnType<typeof searchResultSchema>>

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string(),
    results: z.array(z.union([searchResultSchema(), z.string()])),
    durationSeconds: z.number(),
  }),
)

export type Output = z.infer<ReturnType<typeof outputSchema>>

export type { WebSearchProgress } from '../../types/tools.js'
import type { WebSearchProgress } from '../../types/tools.js'

/**
 * 使用 SearXNG 本地搜索
 */
async function searchSearXNG(
  query: string,
  searchImages?: boolean
): Promise<Array<{ title: string; url: string; snippet?: string; image?: string }>> {
  try {
    const baseUrl = process.env.SEARXNG_BASE_URL || 'http://localhost:8080'
    const url = new URL('/search', baseUrl)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    if (searchImages) {
      url.searchParams.set('categories', 'images')
    }

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebSearchTool/1.0)',
        'Accept': 'application/json',
      },
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(`HTTP ${res.status}: ${errorText}`)
    }

    const data = await res.json()

    return (data.results || [])
      .slice(0, 10)
      .map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        image: r.img_src || r.thumbnail || undefined,
      }))
  } catch (error) {
    logError(new Error('SearXNG search failed', { cause: error }))
    throw new Error(
      `SearXNG search failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 使用 Tavily 云搜索
 */
async function searchTavily(
  query: string
): Promise<Array<{ title: string; url: string; snippet?: string; image?: string }>> {
  try {
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) {
      throw new Error('TAVILY_API_KEY is not set')
    }

    const client = tavily({ apiKey })
    const response = await client.search(query, {
      maxResults: 10,
      searchDepth: 'basic',
      topic: 'general',
    })

    return (response.results || []).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      image: r.img || r.image || undefined,
    }))
  } catch (error) {
    logError(new Error('Tavily search failed', { cause: error }))
    throw new Error(
      `Tavily search failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 文本清洗
 */
function stripTags(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function normalizeText(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function cleanSearchResult(result: any) {
  return {
    title: result.title ? normalizeText(stripTags(result.title)) : undefined,
    snippet: result.snippet ? normalizeText(stripTags(result.snippet)) : undefined,
  }
}

function matchesDomain(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, '')
  const normalizedDomain = domain
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/\.$/, '')
  return Boolean(
    normalizedDomain &&
      (normalizedHost === normalizedDomain ||
        normalizedHost.endsWith(`.${normalizedDomain}`)),
  )
}

function filterSearchResults(
  results: Array<{ title: string; url: string; snippet?: string; image?: string }>,
  allowedDomains?: string[],
  blockedDomains?: string[],
) {
  return results.filter(result => {
    let hostname: string
    try {
      const parsedUrl = new URL(result.url)
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return false
      }
      hostname = parsedUrl.hostname
    } catch {
      return false
    }
    if (
      blockedDomains?.some(domain => matchesDomain(hostname, domain))
    ) {
      return false
    }
    return (
      !allowedDomains?.length ||
      allowedDomains.some(domain => matchesDomain(hostname, domain))
    )
  })
}

export const WebSearchTool = buildTool(({
  name: WEB_SEARCH_TOOL_NAME,
  description: 'Search the web using Firecrawl, Tavily, or SearXNG; image searches use SearXNG.' as unknown as ToolDef['description'],
  // 不 defer: 让 LLM 始终能看到 search_images 参数和图片搜索规则
  shouldDefer: false,

  getToolUseSummary,
  getActivityDescription(input) {
    return input?.query ? `Searching for "${input.query}"` : 'Searching the web'
  },

  isEnabled() {
    return true
  },

  get inputSchema() {
    return inputSchema()
  },

  get outputSchema() {
    return outputSchema()
  },

  isConcurrencySafe() {
    return true
  },

  isReadOnly() {
    return true
  },

  toAutoClassifierInput(input) {
    return input?.query ?? ''
  },

  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'allow',
    }
  },

  async prompt() {
    return getWebSearchPrompt()
  },

  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,

  extractSearchText() {
    return ''
  },

  async validateInput(input) {
    if (!input?.query) {
      return { result: false, message: 'Missing query', errorCode: 1 }
    }
    return { result: true }
  },

  async call(input, _context, _canUseTool, _parentMessage, onProgress) {
    const start = performance.now()

    try {
      if (!input?.query || input.query.trim() === '') {
        return {
          data: {
            query: input?.query || '',
            results: ['Error: Missing query'],
            durationSeconds: (performance.now() - start) / 1000,
          },
        }
      }

      if (onProgress) {
        onProgress({
          toolUseID: 'search-start',
          data: { type: 'query_update', query: input.query },
        })
      }

      let results: Array<{
        title: string
        url: string
        snippet?: string
        image?: string
      }> | undefined
      if (input.search_images) {
        results = await searchSearXNG(input.query, true)
      } else {
        if (hasFirecrawlConfig()) {
          try {
            results = await searchWithFirecrawl(input.query, {
              allowedDomains: input.allowed_domains,
              blockedDomains: input.blocked_domains,
            })
          } catch (firecrawlError) {
            logError(
              new Error('Firecrawl search failed; trying the next backend', {
                cause: firecrawlError,
              }),
            )
          }
        }

        if (!results && process.env.TAVILY_API_KEY) {
          try {
            results = await searchTavily(input.query)
          } catch (tavilyError) {
            logError(
              new Error('Tavily search failed; trying SearXNG', {
                cause: tavilyError,
              }),
            )
          }
        }

        if (!results) {
          results = await searchSearXNG(input.query, false)
        }
      }

      const filtered = filterSearchResults(
        results,
        input.search_images ? undefined : input.allowed_domains,
        input.search_images ? undefined : input.blocked_domains,
      )
      const cleaned = filtered.map(r => ({
        ...r,
        ...cleanSearchResult(r),
      }))

      const output =
        cleaned.length === 0
          ? [`No results for: ${input.query}`]
          : [
            {
              tool_use_id: 'search-1',
              content: cleaned,
            },
          ]

      const duration = (performance.now() - start) / 1000

      return {
        data: {
          query: input.query,
          results: output,
          durationSeconds: duration,
        },
      }
    } catch (error) {
      const duration = (performance.now() - start) / 1000
      const errorMessage = error instanceof Error ? error.message : String(error)

      logError(error)

      return {
        data: {
          query: input?.query || '',
          results: [`Error: ${errorMessage}`],
          durationSeconds: duration,
        },
      }
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (!output) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'Error',
      }
    }

    let text = `Results for "${output.query}"\n\n`

    for (const r of output.results) {
      if (typeof r === 'string') {
        text += r + '\n\n'
      } else {
        r.content.forEach((item: any, i: number) => {
          text += `${i + 1}. ${item.title}\n${item.url}\n${item.snippet || ''}\n`
          if (item.image) {
            text += `Image: ${item.image}\n`
          }
        })
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [{ type: 'text', text }],
    }
  },
} as unknown as Parameters<typeof buildTool>[0]) satisfies ToolDef<any, Output, WebSearchProgress>
)
