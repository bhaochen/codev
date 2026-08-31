/**
 * REPL Execution Engine — Bun VM 沙箱执行用户代码。
 *
 * 使用 node:vm 创建隔离的 JS 上下文，绑定 primitive tools 作为可调用函数。
 * 状态跨多次 execute() 调用持久化（变量绑定保留）。
 *
 * 注意：Bun 的 node:vm 中，async 函数内的 var 声明不会持久化到 context。
 * 因此同步代码直接执行（var 保留），异步代码（含 top-level await）才使用 async 包装。
 */
import { createContext, Script } from 'node:vm'
import { randomUUID } from 'node:crypto'
import type { Tool, ToolUseContext, Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import { expandPath } from '../../utils/path.js'
import { getFileModificationTime } from '../../utils/file.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { createReplHelpers } from './helpers.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import type { AssistantMessage, Message } from '../../types/message.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** callTool 在 VM 中的返回类型（字符串化后的结果） */
type CallToolResult = {
  data: string
  toolName: string
  isError: boolean
}

/** 统一事实模型：所有 primitive tool 的结构化结果 */
export type ToolResult = {
  tool: string
  ok: boolean
  isError: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  data?: unknown
  truncated?: boolean
  noOutputExpected?: boolean
  outputPath?: string
  error?: string
}

/** 暴露给模型的聚合视图：区分 status 与 content */
export type ContextCall = {
  tool: string
  ok: boolean
  exitCode?: number
  summary?: string
  preview?: string
  truncated?: boolean
  outputPath?: string
  noOutputExpected?: boolean
  error?: string
}

export type ContextResult = {
  ok: boolean
  tool_calls: number
  calls: ContextCall[]
  logs?: string
  error?: string
}

const CONTEXT_PREVIEW_LIMIT = 4000
const CONTEXT_PREVIEW_HEAD = 2000

/** canUseTool 自动允许 REPL 内的 primitive tool 调用 */
const canUseToolAllowAll: CanUseToolFn = async () => ({
  behavior: 'allow' as const,
})

/** VM 中禁止访问的标识符 */
const BLOCKED_GLOBALS = new Set([
  'eval',
  'Function',
  'import',
  'process',
  'require',
  'globalThis',
])

export type ReplExecuteResult = {
  result: string
  toolCalls: number
  output: string
  innerMessages: Message[]
}

export type ToolProgressFn = (data: {
  type: string
  phase: string
  toolName: string
  toolInput: unknown
}) => void

export class ReplEngine {
  private context: ReturnType<typeof createContext> | null = null
  private toolCallCount = 0
  private innerMessages: Message[] = []
  private output: string[] = []
  private toolResults: ToolResult[] = []
  private executeError?: string
  private tools: Tools
  private toolUseContext: ToolUseContext
  private onToolProgress?: ToolProgressFn

  constructor(tools: Tools, toolUseContext: ToolUseContext) {
    this.tools = tools
    this.toolUseContext = toolUseContext
  }

  /** 更新 ToolUseContext（每次 turn 可能变化） */
  updateContext(toolUseContext: ToolUseContext): void {
    this.toolUseContext = toolUseContext
  }

  /**
   * 执行代码并返回结果。
   *
   * - 同步代码（无 top-level await）：直接执行，var 声明持久化到 context。
   * - 异步代码（含 top-level await）：用 async IIFE 包装，var 声明留在函数作用域，
   *   但仍会尝试提取 var 名称并注入到 context 以尽量持久化。
   */
  async execute(
    code: string,
    toolUseId: string,
    onToolProgress?: ToolProgressFn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ReplExecuteResult> {
    this.toolCallCount = 0
    this.innerMessages = []
    this.output = []
    this.toolResults = []
    this.executeError = undefined
    this.onToolProgress = onToolProgress

    if (!this.context) {
      this.context = this.createContext()
    }

    // 每次执行重置 console 捕获
    const output = this.output
    ;(this.context as any).console = {
      log: (...args: unknown[]) => {
        output.push(args.map(a => String(a)).join(' '))
      },
      error: (...args: unknown[]) => {
        output.push('[ERROR] ' + args.map(a => String(a)).join(' '))
      },
      warn: (...args: unknown[]) => {
        output.push('[WARN] ' + args.map(a => String(a)).join(' '))
      },
      info: (...args: unknown[]) => {
        output.push(args.map(a => String(a)).join(' '))
      },
      debug: (...args: unknown[]) => {
        output.push('[DEBUG] ' + args.map(a => String(a)).join(' '))
      },
    }

    try {
      if (ReplEngine.hasTopLevelAwait(code)) {
        await this.executeAsync(code, timeoutMs)
      } else {
        this.executeSync(code, timeoutMs)
      }

      const toolOutput = this.output.join('\n')

      // 无工具调用：保持原有行为（兼容纯 JS 计算 / console.log）
      if (this.toolCallCount === 0) {
        return {
          result: toolOutput || '(no output)',
          toolCalls: this.toolCallCount,
          output: toolOutput,
          innerMessages: [...this.innerMessages],
        }
      }

      // 有工具调用：通过 ContextAggregator 生成结构化结果，不依赖 console.log
      const contextResult = this.buildContextResult(toolOutput, undefined)
      return {
        result: JSON.stringify(contextResult, null, 2),
        toolCalls: this.toolCallCount,
        output: toolOutput,
        innerMessages: [...this.innerMessages],
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.executeError = errMsg
      const toolOutput = this.output.join('\n')
      if (this.toolCallCount === 0) {
        return {
          result: `Error: ${errMsg}`,
          toolCalls: this.toolCallCount,
          output: toolOutput,
          innerMessages: [...this.innerMessages],
        }
      }
      const contextResult = this.buildContextResult(toolOutput, errMsg)
      return {
        result: JSON.stringify(contextResult, null, 2),
        toolCalls: this.toolCallCount,
        output: toolOutput,
        innerMessages: [...this.innerMessages],
      }
    }
  }

  /** 同步执行：var 声明会持久化到 context（Bun node:vm 特性） */
  private executeSync(code: string, timeoutMs: number): void {
    const script = new Script(code, { filename: 'repl-eval.mjs' })
    const returnValue = script.runInContext(this.context!, {
      timeout: timeoutMs,
      displayErrors: true,
    })
    // 捕获表达式返回值（如 typeof x、1+1 等），
    // undefined 不输出（和 console.log 行为一致）
    if (returnValue !== undefined) {
      this.output.push(String(returnValue))
    }
  }

  /**
   * 异步执行：用 async IIFE 包装以支持 top-level await。
   * Bun 中 async 函数内的 var 不会持久化到 context，
   * 但会尝试提取 var 名称并手动注入到 context 以尽量保持跨调用状态。
   */
  private async executeAsync(code: string, timeoutMs: number): Promise<void> {
    const wrappedCode = `(async () => { ${code} })()`
    const script = new Script(wrappedCode, { filename: 'repl-eval.mjs' })

    const result = script.runInContext(this.context!, {
      timeout: timeoutMs,
      displayErrors: true,
    })

    // Bun 的 runInContext 对 async IIFE 返回 Promise，需要 await
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      await result
    }

    // 尝试将 var 声明注入到 context 以持久化跨调用状态
    this.injectVarDeclarations(code)
  }

  /**
   * 从代码中提取 var 声明的变量名并注入到 context。
   * 简单 regex 实现，覆盖常见模式：
   * - var x = 42
   * - var x = 42, y = 99
   * - var x             （值为 undefined）
   * 注意：不支持解构声明（var {a, b} = obj），这是已知限制。
   */
  private injectVarDeclarations(code: string): void {
    const ctx = this.context!
    const varPattern = /\bvar\s+([a-zA-Z_$][\w$]*)/g
    let match: RegExpExecArray | null
    while ((match = varPattern.exec(code)) !== null) {
      const varName = match[1]
      // 从 context 获取当前值（如果 sync 部分已设置），
      // 否则保持 undefined
      if (!(varName in ctx)) {
        ;(ctx as any)[varName] = undefined
      }
    }
  }

  /**
   * 检测代码是否包含 top-level await（不含注释和字符串内的）。
   * 用于决定是否需要 async 包装。
   *
   * 注意：简单的 regex 检测，不完美但覆盖常见场景。
   * 不匹配：
   * - 字符串内的 await（如 'await foo'）
   * - 注释内的 await（如 // await）
   * - 函数体内的 await（如 f(() => await x)）— 这些在 sync 模式下也能工作
   */
  private static hasTopLevelAwait(code: string): boolean {
    // 移除字符串和模板字符串（简化处理，不完美）
    const cleaned = code
      .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
      .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''")
      .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, '``')
      // 移除单行注释
      .replace(/\/\/.*$/gm, '')
      // 移除多行注释
      .replace(/\/\*[\s\S]*?\*\//g, '')

    return /\bawait\s/.test(cleaned)
  }

  private buildContextResult(logs: string, error?: string): ContextResult {
    const calls: ContextCall[] = this.toolResults.map(r => {
      // 为不同工具生成合适的 preview / summary
      if (r.tool.toLowerCase() === 'bash') {
        const combined = [r.stdout ?? '', r.stderr ?? ''].filter(Boolean).join('\n')
        const preview = this.buildPreview(combined)
        const summary =
          r.noOutputExpected && !combined
            ? 'Command completed successfully (no output expected)'
            : undefined
        return {
          tool: r.tool,
          ok: r.ok,
          exitCode: r.exitCode,
          summary,
          preview: preview || undefined,
          truncated: r.truncated || (combined.length > CONTEXT_PREVIEW_LIMIT ? true : undefined),
          outputPath: r.outputPath,
          noOutputExpected: r.noOutputExpected || undefined,
          error: r.error,
        }
      }
      // Read / Glob / Grep / Edit / Write 等
      let rawPreview: string
      if (r.data !== undefined) {
        if (typeof r.data === 'string') rawPreview = r.data
        else {
          try {
            rawPreview = JSON.stringify(r.data, null, 2)
          } catch {
            rawPreview = String(r.data)
          }
        }
        // Read 的全量文件内容：只取预览
        if (rawPreview.length > CONTEXT_PREVIEW_LIMIT) {
          rawPreview = this.buildPreview(rawPreview)
        }
      } else {
        rawPreview = r.error ?? ''
      }
      // 简单 summary：Read/Write 带路径提示
      const summary =
        r.ok && rawPreview.length === 0 && r.noOutputExpected
          ? 'Command completed successfully'
          : undefined
      return {
        tool: r.tool,
        ok: r.ok,
        preview: rawPreview || undefined,
        truncated: r.truncated || (rawPreview.length >= CONTEXT_PREVIEW_LIMIT ? true : undefined),
        outputPath: r.outputPath,
        error: r.error,
      }
    })

    const ok = !error && calls.every(c => c.ok)
    return {
      ok,
      tool_calls: this.toolCallCount,
      calls,
      logs: logs || undefined,
      error,
    }
  }

  private buildPreview(text: string): string {
    if (text.length <= CONTEXT_PREVIEW_LIMIT) return text
    const head = text.slice(0, CONTEXT_PREVIEW_HEAD)
    const tail = text.slice(-500)
    return `${head}\n... (truncated, total ${text.length} chars, showing head ${CONTEXT_PREVIEW_HEAD} + tail 500)\n${tail}`
  }

  private createContext() {
    const self = this

    // callTool 函数 — 在 VM 中调用 primitive tools
    const callToolFn = async (
      toolName: string,
      input: Record<string, unknown> = {},
    ): Promise<CallToolResult> => {
      // 大小写不敏感回退查找 — LLM 常写 "glob" 而非 "Glob"
      let tool = findToolByName(self.tools, toolName)
      if (!tool) {
        const lower = toolName.toLowerCase()
        tool = self.tools.find(
          t => t.name.toLowerCase() === lower,
        )
      }
      if (!tool) {
        const errText = `Error: Tool "${toolName}" not found`
        self.toolResults.push({
          tool: toolName,
          ok: false,
          isError: true,
          error: errText,
        })
        // 仍计数为一次调用，确保 ContextResult 能体现失败
        self.toolCallCount++
        return {
          data: errText,
          toolName,
          isError: true,
        }
      }

      // Prime readFileState before Edit/Write so the tool's staleness gate
      // does not reject the call in the REPL (the file need not be Read first
      // in-session). The reliable helpers do this too; this keeps the raw
      // primitive Edit/Write tools working directly.
      const toolNameLower = tool.name.toLowerCase()
      if (
        (toolNameLower === 'edit' || toolNameLower === 'write') &&
        input &&
        typeof input.file_path === 'string'
      ) {
        try {
          const abs = expandPath(input.file_path)
          const meta = readFileSyncWithMetadata(abs)
          self.toolUseContext.readFileState.set(abs, {
            content: meta.content,
            timestamp: getFileModificationTime(abs),
            offset: undefined,
            limit: undefined,
          })
        } catch {
          // file does not exist yet (new file) or unreadable; the tool handles it
        }
      }

      // 校验输入
      const parsed = tool.inputSchema.safeParse(input)
      if (!parsed.success) {
        const errText = `Error: Invalid input for ${toolName}: ${parsed.error.message}`
        self.toolResults.push({
          tool: toolName,
          ok: false,
          isError: true,
          error: errText,
        })
        self.toolCallCount++
        return {
          data: errText,
          toolName,
          isError: true,
        }
      }

      self.toolCallCount++

      // 发送进度消息
      self.onToolProgress?.({
        type: 'repl_tool_call',
        phase: 'start',
        toolName,
        toolInput: input,
      })

      // 创建 synthetic assistant message（tool_use block）
      const innerToolUseId = `toolu_${randomUUID().replaceAll('-', '')}`
      const syntheticAssistant = createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: innerToolUseId,
            name: toolName,
            input,
          },
        ],
      })

      // 调用工具
      try {
        const result = await tool.call(
          parsed.data,
          { ...self.toolUseContext, toolUseId: innerToolUseId },
          canUseToolAllowAll,
          syntheticAssistant,
        )

        // 构造结果文本
        // String(对象) 会变成 "[object Object]"，需要按类型正确序列化
        const resultText =
          typeof result === 'object' && result !== null && 'data' in result
            ? (typeof (result as { data: unknown }).data === 'string'
                ? (result as { data: string }).data
                : JSON.stringify((result as { data: unknown }).data, null, 2))
            : typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2)

        // 创建 virtual messages
        const virtualAssistant = createAssistantMessage({
          content: [
            {
              type: 'tool_use',
              id: innerToolUseId,
              name: toolName,
              input,
            },
          ],
          isVirtual: true,
        })

        const virtualUser = createUserMessage({
          content: [
            {
              type: 'tool_result',
              tool_use_id: innerToolUseId,
              content: resultText,
            },
          ],
          toolUseResult:
            typeof result === 'object' && result !== null && 'data' in result
              ? (result as { data: unknown }).data
              : result,
          isVirtual: true,
        })

        self.innerMessages.push(virtualAssistant, virtualUser)

        // 记录结构化事实：供 ContextAggregator 聚合（不依赖 console.log）
        {
          const rawData =
            typeof result === 'object' && result !== null && 'data' in result
              ? (result as { data: unknown }).data
              : result
          // Bash 的 Out 含 stdout/stderr/persistedOutputPath/noOutputExpected
          const isBash = toolNameLower === 'bash'
          if (isBash && typeof rawData === 'object' && rawData !== null) {
            const out = rawData as {
              stdout?: string
              stderr?: string
              interrupted?: boolean
              persistedOutputPath?: string
              persistedOutputSize?: number
              noOutputExpected?: boolean
            }
            self.toolResults.push({
              tool: toolName,
              ok: true,
              isError: false,
              stdout: out.stdout,
              stderr: out.stderr,
              exitCode: out.interrupted ? undefined : 0,
              truncated: !!out.persistedOutputPath,
              outputPath: out.persistedOutputPath,
              noOutputExpected: out.noOutputExpected,
              data: rawData,
            })
          } else {
            // Read/Glob/Grep/Edit/Write 等：保留原始 data，preview 在聚合阶段截断
            const dataStr = resultText
            const truncated = dataStr.length > CONTEXT_PREVIEW_LIMIT
            self.toolResults.push({
              tool: toolName,
              ok: true,
              isError: false,
              data: rawData,
              truncated: truncated || undefined,
            })
          }
        }

        // 发送完成进度
        self.onToolProgress?.({
          type: 'repl_tool_call',
          phase: 'complete',
          toolName,
          toolInput: input,
        })

        return {
          data: resultText,
          toolName,
          isError: false,
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)

        self.toolResults.push({
          tool: toolName,
          ok: false,
          isError: true,
          error: `Error calling ${toolName}: ${errMsg}`,
        })

        self.onToolProgress?.({
          type: 'repl_tool_call',
          phase: 'error',
          toolName,
          toolInput: input,
        })

        return {
          data: `Error calling ${toolName}: ${errMsg}`,
          toolName,
          isError: true,
        }
      }
    }

    // 安全沙箱：Proxy 拦截禁止的标识符访问
    const helpers = createReplHelpers({
      getContext: () => self.toolUseContext,
      log: (line: string) => {
        self.output.push(line)
      },
    })

    const sandbox: Record<string, unknown> = {
      // 工具调用
      callTool: callToolFn,

      // Reliable file-edit helpers: write directly to disk, print a +/- diff, bypass the readFileState gate
      readFile: helpers.readFile,
      writeFile: helpers.writeFile,
      editFile: helpers.editFile,
      viewFile: helpers.viewFile,
      diffFile: helpers.diffFile,
      showDiff: helpers.showDiff,

      // 安全内置
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      ReferenceError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      btoa,
      atob,
      structuredClone,
      AbortController,
      AbortSignal,
    }

    const proxyHandler: ProxyHandler<Record<string, unknown>> = {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && BLOCKED_GLOBALS.has(prop)) {
          throw new ReferenceError(
            `${prop} is not allowed in sandbox`,
          )
        }
        return Reflect.get(target, prop, receiver)
      },
    }

    return createContext(new Proxy(sandbox, proxyHandler), {
      name: 'repl-sandbox',
      codeGeneration: {
        strings: false, // 禁止 new Function
        wasm: false, // 禁止 WebAssembly
      },
    })
  }

  /** 清除会话状态 */
  reset(): void {
    this.context = null
    this.toolCallCount = 0
    this.innerMessages = []
    this.output = []
    this.toolResults = []
    this.executeError = undefined
  }
}
