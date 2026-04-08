import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * 日志记录函数 - 将日志写入 log.md 文件
 */
function logToMarkdown(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, data?: any) {
  const timestamp = new Date().toISOString()
  const emoji = {
    INFO: '🔵',
    WARN: '⚠️',
    ERROR: '❌',
    DEBUG: '🔍'
  }[level]

  let logEntry = `\n[${timestamp}] [${level}] ${emoji} ${message}`

  if (data !== undefined) {
    if (typeof data === 'string') {
      logEntry += `\n\`\`\`\n${data}\n\`\`\``
    } else {
      logEntry += `\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
    }
  }

  const logPath = join(process.cwd(), 'log.md')

  try {
    // 追加日志到文件
    if (existsSync(logPath)) {
      const existingContent = readFileSync(logPath, 'utf-8')
      writeFileSync(logPath, existingContent + logEntry, 'utf-8')
    } else {
      writeFileSync(logPath, logEntry, 'utf-8')
    }
  } catch (error) {
    // 如果写入日志失败，仍然输出到控制台
    console.error(`[WebSearch] 无法写入日志文件: ${error}`)
  }

  // 同时输出到控制台
  console.log(`[WebSearch] ${level}: ${message}`, data !== undefined ? data : '')
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(2).describe('The search query to use'),
  }),
)

type Input = z.infer<ReturnType<typeof inputSchema>>

const searchResultSchema = lazySchema(() => {
  const searchHitSchema = z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string().optional(),
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
 * ✅ 使用 SearXNG 本地搜索
 */
async function searchSearXNG(
  query: string
): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  logToMarkdown('INFO', '开始搜索 SearXNG')
  logToMarkdown('DEBUG', '搜索查询', query)

  // 断言：查询参数必须有效
  console.assert(
    typeof query === 'string' && query.trim().length > 0,
    `[WebSearch] ❌ 无效的查询参数: ${JSON.stringify(query)}`
  )

  try {
    const url = new URL('http://localhost:8080/search')
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')

    const finalUrl = url.toString()
    logToMarkdown('DEBUG', '请求 URL', finalUrl)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    logToMarkdown('INFO', '发起 HTTP 请求 (10秒超时)')
    const startTime = Date.now()
    const res = await fetch(finalUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebSearchTool/1.0)',
        'Accept': 'application/json',
      },
    })
    const elapsed = Date.now() - startTime

    clearTimeout(timeout)

    const statusInfo = `${res.status} ${res.statusText} (${elapsed}ms)`
    logToMarkdown('INFO', 'HTTP 响应状态', statusInfo)
    logToMarkdown('DEBUG', '响应头 Content-Type', res.headers.get('content-type'))

    // 断言：HTTP 状态码应该是 2xx
    console.assert(
      res.ok,
      `[WebSearch] ❌ HTTP 请求失败: ${res.status} ${res.statusText}`
    )

    if (!res.ok) {
      const errorText = await res.text()
      logToMarkdown('ERROR', '错误响应内容', errorText)
      throw new Error(`HTTP ${res.status}: ${errorText}`)
    }

    logToMarkdown('INFO', '解析 JSON 响应')
    const data = await res.json()

    const resultStats = {
      query: data.query,
      totalResults: data.number_of_results,
      resultsCount: data.results?.length || 0,
    }
    logToMarkdown('INFO', '返回结果统计', resultStats)

    // 断言：响应数据应该包含 results 数组
    console.assert(
      Array.isArray(data.results),
      `[WebSearch] ❌ 响应数据格式错误: results 不是数组, 类型: ${typeof data.results}`
    )

    const results = (data.results || [])
      .slice(0, 10)
      .map((r: any, index: number) => {
        // 断言：每个结果必须有 title 和 url
        console.assert(
          r.title && r.url,
          `[WebSearch] ⚠️ 结果 ${index} 缺少必要字段: ${JSON.stringify(r)}`
        )

        return {
          title: r.title,
          url: r.url,
          snippet: r.content,
        }
      })

    logToMarkdown('INFO', `搜索完成，返回 ${results.length} 条结果`)
    return results
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined

    logToMarkdown('ERROR', '搜索失败', errorMessage)
    if (errorStack) {
      logToMarkdown('ERROR', '错误堆栈', errorStack)
    }

    logError('SearXNG search failed', error)

    // 根据错误类型提供更详细的诊断信息
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        const timeoutReasons = [
          'SearXNG 服务响应过慢',
          '网络连接问题',
          'SearXNG 服务未运行'
        ]
        logToMarkdown('ERROR', '请求超时 (10秒)，可能原因', timeoutReasons)
      } else if (error.message.includes('ECONNREFUSED')) {
        const connectionReasons = [
          'SearXNG 服务未启动',
          '端口 8080 未开放',
          '防火墙阻止连接'
        ]
        logToMarkdown('ERROR', '连接被拒绝，可能原因', connectionReasons)
      } else if (error.message.includes('HTTP 403')) {
        const forbiddenReasons = [
          'SearXNG 配置不允许 JSON 格式',
          'IP 被限制',
          '需要认证'
        ]
        logToMarkdown('ERROR', 'HTTP 403 禁止访问，可能原因', forbiddenReasons)
      }
    }

    throw new Error(
      `SearXNG search failed: ${errorMessage}`
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

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  description: 'Search the web using local SearXNG',

  getToolUseSummary,
  getActivityDescription(input) {
    return input?.query ? `Searching for "${input.query}"` : 'Searching the web'
  },

  isEnabled() {
    const enabled = true
    logToMarkdown('DEBUG', `isEnabled() = ${enabled}`)
    return enabled
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
    logToMarkdown('DEBUG', 'validateInput() 被调用')
    logToMarkdown('DEBUG', '输入参数', input)

    if (!input?.query) {
      logToMarkdown('ERROR', '验证失败: Missing query')
      return { result: false, message: 'Missing query', errorCode: 1 }
    }

    logToMarkdown('INFO', '验证通过')
    return { result: true }
  },

  async call(input, _context, _canUseTool, _parentMessage, onProgress) {
    const start = performance.now()

    logToMarkdown('INFO', 'WebSearchTool.call() 被调用')
    logToMarkdown('DEBUG', '输入参数', input)

    // 断言：input 必须存在
    console.assert(
      input !== null && input !== undefined,
      `[WebSearch] ❌ input 参数为 null/undefined`
    )

    try {
      // 验证查询参数
      if (!input?.query || input.query.trim() === '') {
        logToMarkdown('WARN', '查询参数为空，返回错误')
        return {
          data: {
            query: input?.query || '',
            results: ['Error: Missing query'],
            durationSeconds: (performance.now() - start) / 1000,
          },
        }
      }

      // 断言：查询长度必须至少 2 个字符（根据 inputSchema 定义）
      console.assert(
        input.query.trim().length >= 2,
        `[WebSearch] ❌ 查询长度不足: "${input.query}" (长度: ${input.query.length})`
      )

      logToMarkdown('INFO', `查询参数验证通过: "${input.query}"`)

      if (onProgress) {
        logToMarkdown('DEBUG', '发送进度更新')
        onProgress({
          toolUseID: 'search-start',
          data: { type: 'query_update', query: input.query },
        })
      }

      logToMarkdown('INFO', '调用 searchSearXNG()')
      const results = await searchSearXNG(input.query)

      logToMarkdown('INFO', '清洗搜索结果')
      const cleaned = results.map(r => {
        const cleanedResult = cleanSearchResult(r)
        logToMarkdown('DEBUG', '清洗结果', {
          originalTitle: r.title,
          cleanedTitle: cleanedResult.title,
          hasSnippet: !!r.snippet,
        })
        return {
          ...r,
          ...cleanedResult,
        }
      })

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

      const finalStats = {
        query: input.query,
        resultsCount: cleaned.length,
        durationSeconds: duration.toFixed(3),
      }
      logToMarkdown('INFO', '搜索成功完成')
      logToMarkdown('INFO', '最终统计', finalStats)

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

      logToMarkdown('ERROR', 'WebSearchTool.call() 发生异常')
      logToMarkdown('ERROR', '异常信息', errorMessage)
      if (error instanceof Error && error.stack) {
        logToMarkdown('ERROR', '异常堆栈', error.stack)
      }

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
          text += `${i + 1}. ${item.title}\n${item.url}\n${item.snippet || ''}\n\n`
        })
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: text,
    }
  },
}) satisfies ToolDef<any, Output, WebSearchProgress>
