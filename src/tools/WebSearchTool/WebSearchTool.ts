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
import { jinaSearch } from './jina_search'

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
 * Search using DuckDuckGo via Python webtools script
 * Uses subprocess to call Python script with nanobot implementation
 */
async function searchDuckDuckGoAPI(
  query: string,
  options: {
    region?: string
    timelimit?: string
    page?: number
  } = {}
): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  const { page = 1 } = options

  console.log(`[WebSearch] Searching DuckDuckGo for: "${query}" (via Python webtools)`)

  try {
    const { spawn } = await import('child_process')
    
    return new Promise((resolve, reject) => {
      const pythonScript = process.cwd() + '/scripts/python_webtools.py'
      const maxResults = 10
      
      const child = spawn('.venv/bin/python', [pythonScript, 'web_search', query, String(maxResults)], {
        cwd: process.cwd(),
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code !== 0) {
          console.error('[WebSearch] Python script failed:', stderr)
          reject(new Error(`Python script failed: ${stderr}`))
          return
        }

        try {
          const result = JSON.parse(stdout)
          
          if (!result.success) {
            console.error('[WebSearch] Python search failed:', result.error)
            reject(new Error(result.error))
            return
          }

          console.log(`[WebSearch] Python returned ${result.count} results`)
          
          // Convert Python results to our format
          const results: Array<{ title: string; url: string; snippet?: string }> = result.results.map((r: any) => ({
            title: r.title,
            url: r.url,
            snippet: r.content || undefined,
          }))
          
          resolve(results)
        } catch (error) {
          console.error('[WebSearch] Failed to parse Python output:', error)
          reject(new Error(`Failed to parse Python output: ${error}`))
        }
      })

      child.on('error', (error) => {
        console.error('[WebSearch] Failed to start Python process:', error)
        reject(error)
      })
    })
  } catch (error) {
    console.error('[WebSearch] Failed to search:', error)
    logError('WebSearch failed', error)
    throw new Error(`Unable to search: ${error instanceof Error ? error.message : String(error)}`)
  }
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
    // 同时自动过滤掉 AI 模型自动添加的域名限制参数
    const cleanedInput = { ..._input }
    delete cleanedInput.allowed_domains
    delete cleanedInput.blocked_domains
    
    return {
      behavior: 'allow',
      updatedInput: cleanedInput,
      decisionReason: { type: 'other', reason: 'All web searches allowed - domain filters removed' },
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
    const { query } = input
    if (!query?.length) {
      return {
        result: false,
        message: 'Error: Missing query',
        errorCode: 1,
      }
    }
    // 移除域名限制检查，因为会在 checkPermissions 中自动清理
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
      // Add a small delay before making the request to avoid triggering anti-scraping
      if (onProgress) {
        onProgress({
          toolUseID: 'search-delay',
          data: { type: 'delay_start' },
        })
      }
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Use Jina Search
      console.log(`[WebSearch] Using Jina Search for: "${query}"`)
      const jinaResult = await jinaSearch(query)

      // Parse Jina search results
      let results: Array<{ title: string; url: string; snippet?: string }> = []

      if (jinaResult.startsWith('Error:')) {
        throw new Error(`Jina Search failed: ${jinaResult}`)
      } else {
        // Parse the formatted results
        const lines = jinaResult.split('\n').filter(line => line.trim())

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Match pattern: "1. Title\n   URL\n   snippet"
          const match = line.match(/^\d+\.\s+(.+)$/)
          if (match) {
            const title = match[1]
            if (i + 1 < lines.length && lines[i + 1].startsWith('   ')) {
              const urlLine = lines[i + 1].trim()
              const urlMatch = urlLine.match(/^URL:\s*(.+)$/)
              const url = urlMatch ? urlMatch[1] : ''
              let snippet = ''

              if (i + 2 < lines.length && lines[i + 2].startsWith('   ')) {
                snippet = lines[i + 2].trim()
              }

              if (url) {
                results.push({ title, url, snippet })
              }
            }
          }
        }
      }

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
        // Search result with links - format as readable text
        if (result.content?.length > 0) {
          result.content.forEach((item: any, index: number) => {
            formattedOutput += `${index + 1}. **${item.title || 'Untitled'}**\n`
            formattedOutput += `   URL: ${item.url}\n`
            if (item.snippet) {
              formattedOutput += `   ${item.snippet}\n`
            }
            formattedOutput += '\n'
          })
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