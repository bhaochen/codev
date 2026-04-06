import { search } from 'duck-duck-scrape'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
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

export const WebSearchTool = buildTool<InputSchema, Output, WebSearchTool>({
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
    return input.query
  },
  async checkPermissions(_input): Promise<PermissionResult> {
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
  async validateInput(input) {
    const { query, allowed_domains, blocked_domains } = input
    if (!query.length) {
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
    const { query, allowed_domains, blocked_domains } = input

    // Progress update: starting search
    if (onProgress) {
      onProgress({
        toolUseID: 'search-progress-1',
        data: { type: 'query_update', query },
      })
    }

    try {
      // Call DuckDuckGo search
      const response = await search(query, {
        safeSearch: 'moderate',
      })

      // Filter results by domain if specified
      let filteredResults = response.results
      if (allowed_domains || blocked_domains) {
        filteredResults = filterDomains(
          response.results,
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
      const results: (SearchResult | string)[] = []
      
      if (filteredResults.length === 0) {
        results.push(`No results for: ${query}`)
      } else {
        results.push({
          tool_use_id: 'search-1',
          content: filteredResults.map(r => ({
            title: r.title,
            url: r.url,
          }))
        })
      }

      const endTime = performance.now()
      const durationSeconds = (endTime - startTime) / 1000

      return {
        query,
        results,
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
    const { query, results } = output

    let formattedOutput = `Web search results for query: "${query}"\n\n`

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