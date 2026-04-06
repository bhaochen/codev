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
 * Search using DuckDuckGo Instant Answer API
 */
async function searchDuckDuckGoAPI(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  const url = new URL('https://api.duckduckgo.com/')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('no_html', '1')
  url.searchParams.set('skip_disambig', '0')

  const response = await fetch(url.toString())

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()
  const results: Array<{ title: string; url: string; snippet?: string }> = []

  // Add abstract if available
  if (data.Abstract && data.AbstractURL) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: data.Abstract,
    })
  }

  // Add related topics
  if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
    for (const topic of data.RelatedTopics) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(' - ')[0] || 'Related',
          url: topic.FirstURL,
          snippet: topic.Text,
        })
      }
      // Handle nested topics
      if (topic.Topics && Array.isArray(topic.Topics)) {
        for (const subTopic of topic.Topics) {
          if (subTopic.Text && subTopic.FirstURL) {
            results.push({
              title: subTopic.Text.split(' - ')[0] || 'Related',
              url: subTopic.FirstURL,
              snippet: subTopic.Text,
            })
          }
        }
      }
    }
  }

  // Add results from Infobox if available
  if (data.Infobox?.content && Array.isArray(data.Infobox.content)) {
    for (const item of data.Infobox.content) {
      if (item.label && item.value && item.url) {
        results.push({
          title: item.label,
          url: item.url,
          snippet: `${item.label}: ${item.value}`,
        })
      }
    }
  }

  return results.slice(0, 10)
}

/**
 * Search Wikipedia API
 */
async function searchWikipedia(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  const url = new URL('https://en.wikipedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('list', 'search')
  url.searchParams.set('srsearch', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('srlimit', '10')
  url.searchParams.set('srprop', 'snippet')

  const response = await fetch(url.toString())

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()
  const results: Array<{ title: string; url: string; snippet?: string }> = []

  if (data.query?.search) {
    for (const item of data.query.search) {
      results.push({
        title: item.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
        snippet: item.snippet?.replace(/<\/?span[^>]*>/g, ''),
      })
    }
  }

  return results
}

/**
 * Combined search using multiple sources
 */
async function searchBrave(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  const results: Array<{ title: string; url: string; snippet?: string }> = []

  // Try DuckDuckGo Instant Answer API first
  try {
    const ddgResults = await searchDuckDuckGoAPI(query)
    results.push(...ddgResults)
  } catch (e) {
    // Continue to next source
  }

  // Add Wikipedia results
  try {
    const wikiResults = await searchWikipedia(query)
    for (const result of wikiResults) {
      // Avoid duplicates
      if (!results.some(r => r.url === result.url)) {
        results.push(result)
      }
    }
  } catch (e) {
    // Continue
  }

  return results.slice(0, 10)
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

export const WebSearchTool = buildTool<InputSchema, Output, WebSearchProgress>({
  name: WEB_SEARCH_TOOL_NAME,
  description: 'Search the web and return search results with titles, URLs, and snippets.',
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching the web'
  },
  isEnabled() {
    // DuckDuckGo works with all providers, including local models
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
    return {
      behavior: 'passthrough',
      message: 'WebSearchTool requires permission.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: WEB_SEARCH_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
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
      // Call Brave Search
      const results = await searchBrave(query)

      // Filter results by domain if specified
      let filteredResults = results
      if (allowed_domains || blocked_domains) {
        filteredResults = filterDomains(
          results,
          allowed_domains,
          blocked_domains
        )
      }

      // Progress update: results received
      if (onProgress) {
        onProgress({
          toolUseID: 'search-progress-2',
          data: {
            type: 'search_results_received',
            resultCount: filteredResults.length,
            query,
          },
        })
      }

      // Convert to output format
      const searchResults: (SearchResult | string)[] = []
      
      if (filteredResults.length === 0) {
        searchResults.push(`No results for: ${query}`)
      } else {
        searchResults.push({
          tool_use_id: 'search-1',
          content: filteredResults.map(r => ({
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