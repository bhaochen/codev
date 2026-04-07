import { z } from 'zod/v4' // 引入 Zod: 定义 & 检验输入输出结构
import { buildTool, type ToolDef } from '../../Tool.js' // 构建工具对象, 工具类型约束
import { formatFileSize } from '../../utils/format.js' // 字节 -> 可读格式(KB/MB)
import { lazySchema } from '../../utils/lazySchema.js' // 延迟初始化 schema (避免循环依赖)
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js' // 权限检查返回结构
import { DESCRIPTION, WEB_FETCH_TOOL_NAME } from './prompt.js' // 工具描述 & 名字
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js' // UI 渲染函数
import {
  applyPromptToMarkdown,
  type FetchedContent,
  getURLMarkdownContent,
  isPreapprovedUrl,
  MAX_MARKDOWN_LENGTH,
  UNTRUSTED_BANNER,
} from './utils.js' // 抓网页, 处理 markdown, 判断 url 是否可信

const inputSchema = lazySchema(() =>
  z.strictObject({ // 严格对象 不允许多字段
    url: z.string().url().describe('The URL to fetch content from'), // url: string, 必须是合法 url
    prompt: z.string().describe('The prompt to run on the fetched content'), // 对网页内容执行的任务 总结/提取
  }), // 延迟创建 schema
)

type InputSchema = ReturnType<typeof inputSchema> // 推导类型

const outputSchema = lazySchema(() =>
  z.object({
    bytes: z.number().describe('Size of the fetched content in bytes'), // 返回数据大小
    code: z.number().describe('HTTP response code'), // HTTP 状态码
    codeText: z.string().describe('HTTP response code text'), // 状态描述
    result: z
      .string() // 最终结果
      .describe('Processed result from applying the prompt to the content'),
    durationMs: z
      .number() // 执行耗时
      .describe('Time taken to fetch and process the content'),
    url: z.string().describe('The URL that was fetched'), // url
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema> // 输出类型推导

// Tool 定义开始
export const WebFetchTool = buildTool({
  name: WEB_FETCH_TOOL_NAME, // 工具名
  searchHint: 'fetch and extract content from a URL', // 给 llm 的提示
  // 100K chars - tool result persistence threshold
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    const { url } = input as { url: string } // 类型断言
    try {
      const hostname = new URL(url).hostname
      return `VersperClaw wants to fetch content from ${hostname}` // 用户提示
    } catch {
      return `VersperClaw wants to fetch content from this URL`
    }
  },
  userFacingName() {
    return 'Fetch' // UI 名称
  },
  // 摘要 & 活动描述
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Fetching ${summary}` : 'Fetching web page'
  },
  // schema getter
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 工具属性
  isConcurrencySafe() {
    return true // 支持并发
  },
  isReadOnly() {
    return true // 不修改系统
  },
  toAutoClassifierInput(input) {
    return input.prompt ? `${input.url}: ${input.prompt}` : input.url
  },
  // 权限检查 - 完全开放，允许所有 WebFetch 请求
  async checkPermissions(_input, _context): Promise<PermissionDecision> {
    return {
      behavior: 'allow',
      updatedInput: _input,
      decisionReason: { type: 'other', reason: 'All web fetches allowed' },
    }
  },
  async prompt(_options) {
    // Always include the auth warning regardless of whether ToolSearch is
    // currently in the tools list. Conditionally toggling this prefix based
    // on ToolSearch availability caused the tool description to flicker
    // between SDK query() calls (when ToolSearch enablement varies due to
    // MCP tool count thresholds), invalidating the Anthropic API prompt
    // cache on each toggle — two consecutive cache misses per flicker event.
    return `IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.
${DESCRIPTION}`
  },
  async validateInput(input) {
    const { url } = input
    try {
      new URL(url)
    } catch {
      return {
        result: false,
        message: `Error: Invalid URL "${url}". The URL provided could not be parsed.`,
        meta: { reason: 'invalid_url' },
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(
    { url, prompt },
    { abortController, options: { isNonInteractiveSession } },
  ) {
    const start = Date.now()

    // Provide a default prompt if not provided
    const effectivePrompt = prompt?.trim() || 'Summarize the main content of this page'

    const response = await getURLMarkdownContent(url, abortController)

    // Check if we got a redirect to a different host
    if ('type' in response && response.type === 'redirect') {
      const statusText =
        response.statusCode === 301
          ? 'Moved Permanently'
          : response.statusCode === 308
            ? 'Permanent Redirect'
            : response.statusCode === 307
              ? 'Temporary Redirect'
              : 'Found'

      const message = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:
- url: "${response.redirectUrl}"
- prompt: "${effectivePrompt}"`

      const output: Output = {
        bytes: Buffer.byteLength(message),
        code: response.statusCode,
        codeText: statusText,
        result: message,
        durationMs: Date.now() - start,
        url,
      }

      return {
        data: output,
      }
    }

    const {
      content,
      bytes,
      code,
      codeText,
      contentType,
      persistedPath,
      persistedSize,
    } = response as FetchedContent

    const isPreapproved = isPreapprovedUrl(url)

    let result: string
    if (
      isPreapproved &&
      contentType.includes('text/markdown') &&
      content.length < MAX_MARKDOWN_LENGTH
    ) {
      result = content
    } else {
      result = await applyPromptToMarkdown(
        effectivePrompt,
        content,
        abortController.signal,
        isNonInteractiveSession,
        isPreapproved,
      )
    }

    // Add untrusted banner for non-preapproved content
    if (!isPreapproved) {
      result = `${UNTRUSTED_BANNER}\n\n${result}`
    }

    // Binary content (PDFs, etc.) was additionally saved to disk with a
    // mime-derived extension. Note it so Claude can inspect the raw file
    // if the Haiku summary above isn't enough.
    if (persistedPath) {
      result += `\n\n[Binary content (${contentType}, ${formatFileSize(persistedSize ?? bytes)}) also saved to ${persistedPath}]`
    }

    const output: Output = {
      bytes,
      code,
      codeText,
      result,
      durationMs: Date.now() - start,
      url,
    }

    return {
      data: output,
    }
  },
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
