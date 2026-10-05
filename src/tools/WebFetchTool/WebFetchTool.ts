import { z } from 'zod/v4' // 引入 Zod: 定义 & 检验输入输出结构
import { buildTool, type ToolDef } from '../../Tool.js' // 构建工具对象, 工具类型约束
import { lazySchema } from '../../utils/lazySchema.js' // 延迟初始化 schema (避免循环依赖)
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js' // 权限检查返回结构
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { DESCRIPTION, WEB_FETCH_TOOL_NAME } from './prompt.js' // 工具描述 & 名字
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js' // UI 渲染函数
import {
  type FetchedContent,
  applyPromptToMarkdown,
  getURLMarkdownContent,
  isPreapprovedUrl,
  validateURL,
  WebFetchHttpError,
} from './utils.js' // 抓网页, 处理 markdown

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

export type Output = z.infer<OutputSchema>

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
      return `Codev wants to fetch content from ${hostname}` // 用户提示
    } catch {
      return `Codev wants to fetch content from this URL`
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
  async checkPermissions(input, context): Promise<PermissionDecision> {
    if (!validateURL(input.url)) {
      return {
        behavior: 'deny',
        message: 'WebFetch requires a valid public HTTP or HTTPS URL.',
        decisionReason: { type: 'other', reason: 'Invalid or private URL' },
      }
    }

    let hostname: string
    try {
      hostname = new URL(input.url).hostname.toLowerCase()
    } catch {
      return {
        behavior: 'deny',
        message: 'WebFetch requires a valid public HTTP or HTTPS URL.',
        decisionReason: { type: 'other', reason: 'Invalid URL' },
      }
    }

    if (isPreapprovedUrl(input.url)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'other', reason: 'Preapproved documentation host' },
      }
    }

    const ruleContent = `domain:${hostname}`
    const permissionContext = context.getAppState().toolPermissionContext
    const denyRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'deny',
    ).get(ruleContent)
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `WebFetch is denied for ${hostname}.`,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }

    const allowRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'allow',
    ).get(ruleContent)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule: allowRule },
      }
    }

    const askRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'ask',
    ).get(ruleContent)
    const suggestion: PermissionUpdate = {
      type: 'addRules',
      destination: 'localSettings',
      rules: [{ toolName: WEB_FETCH_TOOL_NAME, ruleContent }],
      behavior: 'allow',
    }
    return {
      behavior: 'ask',
      message: askRule
        ? `WebFetch requires approval for ${hostname}.`
        : `Allow WebFetch to access ${hostname}?`,
      ...(askRule && {
        decisionReason: { type: 'rule' as const, rule: askRule },
      }),
      suggestions: [suggestion],
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
    context,
  ) {
    const start = Date.now()
    const abortController =
      context?.abortController ?? new AbortController()
    const isNonInteractiveSession =
      context?.options?.isNonInteractiveSession ?? false

    try {
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
- url: "${response.redirectUrl}"`

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
        persistedPath,
        persistedSize,
      } = response as FetchedContent

      // Apply the requested extraction to the fetched page content.
      let result = await applyPromptToMarkdown(
        prompt,
        content,
        abortController.signal,
        isNonInteractiveSession,
        isPreapprovedUrl(url),
      )

      // Binary content (PDFs, etc.) was additionally saved to disk with a
      // mime-derived extension. Note it so the user can inspect the raw file.
      if (persistedPath) {
        result += `\n\n[Binary content also saved to ${persistedPath}]`
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
    } catch (error) {
      // Handle errors from getURLMarkdownContent
      const errorMessage = `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`
      const statusCode =
        error instanceof WebFetchHttpError ? error.statusCode : 0
      const statusText =
        error instanceof WebFetchHttpError ? error.statusText : 'Error'

      const output: Output = {
        bytes: Buffer.byteLength(errorMessage),
        code: statusCode,
        codeText: statusText,
        result: errorMessage,
        durationMs: Date.now() - start,
        url,
      }

      return {
        data: output,
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        { type: 'text', text: output.result },
      ],
      is_error:
        output.code === 0 || output.code >= 400 ? true : undefined,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
