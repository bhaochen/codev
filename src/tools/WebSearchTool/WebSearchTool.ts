import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import { TLSFetch } from '@yukiakai/tls-fetch'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(2).describe('The search query to use'),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('Only include search results from these domains'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe('Never include search results from these domains'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Input = z.infer<InputSchema>

const searchResultSchema = lazySchema(() => {
  const searchHitSchema = z.object({
    title: z.string().describe('The title of the search result'),
    url: z.string().describe('The URL of the search result'),
    snippet: z.string().optional().describe('The snippet/description of the search result'),
  })

  return z.object({
    tool_use_id: z.string().describe('ID of the tool use'),
    content: z.array(searchHitSchema).describe('Array of search hits'),
  })
})

export type SearchResult = z.infer<ReturnType<typeof searchResultSchema>>

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe('The search query that was executed'),
    results: z
      .array(z.union([searchResultSchema(), z.string()]))
      .describe('Search results and/or text commentary from the model'),
    durationSeconds: z
      .number()
      .describe('Time taken to complete the search operation'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Re-export WebSearchProgress from centralized types to break import cycles
export type { WebSearchProgress } from '../../types/tools.js'

import type { WebSearchProgress } from '../../types/tools.js'

/**
 * Search using DuckDuckGo HTML results page
 * Uses TLSFetch to bypass CAPTCHA and improved HTML parsing
 */
async function searchDuckDuckGoAPI(
  query: string,
  options: {
    region?: string
    timelimit?: string
    page?: number
  } = {}
): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  const { region = 'us-en', timelimit, page = 1 } = options

  console.log(`[WebSearch] Searching DuckDuckGo for: "${query}" (region=${region}, page=${page})`)

  // Build POST parameters
  const formData = new URLSearchParams()
  formData.append('q', query)
  formData.append('b', '') // Start offset (empty for first page)
  formData.append('l', region) // Locale/region

  // Add offset for pagination
  if (page > 1) {
    const offset = 10 + (page - 2) * 15
    formData.set('b', String(offset))
  }

  // Add time limit filter
  if (timelimit) {
    formData.append('df', timelimit)
  }

  let response
  try {
    // Use TLSFetch to bypass CAPTCHA
    response = await TLSFetch.post('https://html.duckduckgo.com/html/', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
      },
      body: Buffer.from(formData.toString()),
    })
    console.log(`[WebSearch] DuckDuckGo response status: ${response.statusCode}`)
  } catch (error) {
    console.error('[WebSearch] Failed to connect to DuckDuckGo:', error)
    logError('WebSearch: Failed to connect to DuckDuckGo', error)
    throw new Error(`Unable to connect to DuckDuckGo: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (response.statusCode !== 200) {
    console.error(`[WebSearch] DuckDuckGo returned HTTP ${response.statusCode}`)
    throw new Error(`HTTP ${response.statusCode}`)
  }

  const html = response.text()
  console.log(`[WebSearch] Received ${html.length} bytes from DuckDuckGo`)

  const results: Array<{ title: string; url: string; snippet?: string }> = []

  // Check for CAPTCHA challenge
  const captchaPatterns = [
    'Unfortunately, bots use DuckDuckGo too',
    'Select all squares containing a duck',
    'CAPTCHA',
    'challenge-platform',
    'human verification',
    'Please verify you are a human',
    'Checking your browser before accessing',
  ]
  const isCaptcha = captchaPatterns.some(pattern => html.includes(pattern))
  if (isCaptcha) {
    console.warn('[WebSearch] DuckDuckGo returned CAPTCHA challenge')
    logError('DuckDuckGo returned CAPTCHA challenge, skipping search')
    return []
  }

  // Check if HTML is too short
  if (html.length < 1000) {
    console.warn(`[WebSearch] DuckDuckGo response too short (${html.length} bytes)`)
    return []
  }

  // Parse results using the correct pattern
  // Pattern: <div class="result results_links results_links_deep web-result">
  const resultBlocks = html.match(/<div[^>]*class="[^"]*\bweb-result\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi) || []

  console.log(`[WebSearch] Found ${resultBlocks.length} result blocks`)

  for (const block of resultBlocks.slice(0, 10)) {
    try {
      // Extract title and URL from the link
      const titleUrlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
      if (!titleUrlMatch) continue

      const rawUrl = titleUrlMatch[1]
      const title = normalizeText(stripTags(titleUrlMatch[2]))

      // Decode URL
      let decodedUrl = rawUrl
      try {
        if (rawUrl.includes('/l/?uddg=')) {
          const uddgMatch = rawUrl.match(/uddg=([^&]+)/)
          if (uddgMatch) {
            decodedUrl = decodeURIComponent(uddgMatch[1])
          }
        } else if (rawUrl.startsWith('//')) {
          decodedUrl = 'https:' + rawUrl
        } else if (!rawUrl.startsWith('http')) {
          decodedUrl = 'https://' + rawUrl
        }
      } catch {
        decodedUrl = rawUrl
      }

      // Extract snippet from result__snippet class
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      const snippet = snippetMatch
        ? normalizeText(stripTags(snippetMatch[1]))
        : ''

      // Filter out DuckDuckGo's internal links
      if (title && decodedUrl && !decodedUrl.includes('duckduckgo.com') && !decodedUrl.includes('/y.js?')) {
        results.push({
          title,
          url: decodedUrl,
          snippet: snippet || undefined,
        })
      }
    } catch (error) {
      console.debug('[WebSearch] Failed to parse a result block:', error)
      continue
    }
  }

  console.log(`[WebSearch] Successfully parsed ${results.length} results`)
  return results
}

/**
 * Filter search results by domain
 */
function filterDomains(
  results: Array<{ url: string }>,
  allowedDomains?: string[],
  blockedDomains?: string[]
): Array<{ url: string }> {
  return results.filter(result => {
    try {
      const url = new URL(result.url)
      const domain = url.hostname

      if (allowedDomains?.length > 0) {
        return allowedDomains.some(allowed =>
          domain === allowed || domain.endsWith(`.${allowed}`)
        )
      }

      if (blockedDomains?.length > 0) {
        return !blockedDomains.some(blocked =>
          domain === blocked || domain.endsWith(`.${blocked}`)
        )
      }

      return true
    } catch {
      // Invalid URL, filter it out
      return false
    }
  })
}

/**
 * Remove HTML tags and decode HTML entities
 */
function stripTags(text: string): string {
  // Remove script and style tags with their content
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '')
  
  // Decode basic HTML entities
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#39;/g, "'")
  text = text.replace(/&nbsp;/g, ' ')
  
  return text.trim()
}

/**
 * Normalize whitespace in text
 */
function normalizeText(text: string): string {
  // Collapse multiple spaces and tabs into single space
  text = text.replace(/[ \t]+/g, ' ')
  
  // Collapse 3 or more consecutive newlines into 2 newlines
  text = text.replace(/\n{3,}/g, '\n\n')
  
  return text.trim()
}

/**
 * Clean and normalize search result fields
 */
function cleanSearchResult(result: { title?: string; snippet?: string }): { title?: string; snippet?: string } {
  const cleaned: { title?: string; snippet?: string } = {}
  
  if (result.title !== undefined) {
    cleaned.title = normalizeText(stripTags(result.title))
  }
  
  if (result.snippet !== undefined) {
    cleaned.snippet = normalizeText(stripTags(result.snippet))
  }
  
  return cleaned
}

export const WebSearchTool = buildTool<InputSchema, Output, WebSearchProgress>({
  name: WEB_SEARCH_TOOL_NAME,
  description: 'Search the web and return search results with titles, URLs, and snippets.',
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching the web'
  },
  isEnabled() {
    // Jina Search works with all providers, including local models
    return true
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
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
  async checkPermissions(_input, _context): Promise<PermissionResult> {
    // 权限全开，允许所有 WebSearch 请求
    return {
      behavior: 'allow',
      updatedInput: _input,
      decisionReason: { type: 'other', reason: 'All web searches allowed' },
    }
  },
  async prompt() {
    return getWebSearchPrompt()
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  extractSearchText() {
    // renderToolResultMessage shows only "Did N searches in Xs" chrome —
    // the results[] content never appears on screen. Heuristic would index
    // string entries in results[] (phantom match). Nothing to search.
    return ''
  },
  async validateInput(input, _context) {
    if (!input) {
      return {
        result: false,
        message: 'Error: Missing input',
        errorCode: 1,
      }
    }
    const { query, allowed_domains, blocked_domains } = input
    if (!query?.length) {
      return {
        result: false,
        message: 'Error: Missing query',
        errorCode: 1,
      }
    }
    if (allowed_domains?.length && blocked_domains?.length) {
      return {
        result: false,
        message:
          'Error: Cannot specify both allowed_domains and blocked_domains in the same request',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(input, context, _canUseTool, _parentMessage, onProgress) {
    const startTime = performance.now()
    
    if (!input?.query) {
      const endTime = performance.now()
      return {
        query: '',
        results: ['Error: Missing query'],
        durationSeconds: (endTime - startTime) / 1000,
      }
    }
    
    const { query, allowed_domains, blocked_domains } = input

    // Progress update: starting search
    if (onProgress) {
      onProgress({
        toolUseID: 'search-progress-1',
        data: { type: 'query_update', query },
      })
    }

    try {
      // Call DuckDuckGo Search
      const results = await searchDuckDuckGoAPI(query)

      // Filter results by domain if specified
      let filteredResults = results
      if (allowed_domains || blocked_domains) {
        filteredResults = filterDomains(
          results,
          allowed_domains,
          blocked_domains
        )
      }

      // Clean and normalize search results
      const cleanedResults = filteredResults.map(r => ({
        ...r,
        ...cleanSearchResult(r),
      }))

      // Progress update: results received
      if (onProgress) {
        onProgress({
          toolUseID: 'search-progress-2',
          data: {
            type: 'search_results_received',
            resultCount: cleanedResults.length,
            query,
          },
        })
      }

      // Convert to output format
      const searchResults: (SearchResult | string)[] = []
      
      if (cleanedResults.length === 0) {
        searchResults.push(`No results for: ${query}`)
      } else {
        searchResults.push({
          tool_use_id: 'search-1',
          content: cleanedResults.map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
          }))
        })
      }

      const endTime = performance.now()
      const durationSeconds = (endTime - startTime) / 1000

      return {
        query,
        results: searchResults,
        durationSeconds,
      }
    } catch (error) {
      logError(error)
      
      const endTime = performance.now()
      const durationSeconds = (endTime - startTime) / 1000

      return {
        query,
        results: [`Error: ${error instanceof Error ? error.message : String(error)}`],
        durationSeconds,
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (!output) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'Error: Missing output',
      }
    }
    const { query, results } = output

    let formattedOutput = query 
      ? `Web search results for query: "${query}"\n\n`
      : 'Web search results:\n\n'

    // Process the results array - it can contain both string summaries and search result objects.
    // Guard against null/undefined entries that can appear after JSON round-tripping
    // (e.g., from compaction or transcript deserialization).
    ;(results ?? []).forEach(result => {
      if (result == null) {
        return
      }
      if (typeof result === 'string') {
        // Text summary
        formattedOutput += result + '\n\n'
      } else {
        // Search result with links
        if (result.content?.length > 0) {
          formattedOutput += `Links: ${jsonStringify(result.content)}\n\n`
        } else {
          formattedOutput += 'No links found.\n\n'
        }
      }
    })

    formattedOutput +=
      '\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formattedOutput.trim(),
    }
  },
}) satisfies ToolDef<InputSchema, Output, WebSearchProgress>