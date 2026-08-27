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
      return {
        result: toolOutput || '(no output)',
        toolCalls: this.toolCallCount,
        output: toolOutput,
        innerMessages: [...this.innerMessages],
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        result: `Error: ${errMsg}`,
        toolCalls: this.toolCallCount,
        output: this.output.join('\n'),
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
        return {
          data: `Error: Tool "${toolName}" not found`,
          toolName,
          isError: true,
        }
      }

      // 校验输入
      const parsed = tool.inputSchema.safeParse(input)
      if (!parsed.success) {
        return {
          data: `Error: Invalid input for ${toolName}: ${parsed.error.message}`,
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
    const sandbox: Record<string, unknown> = {
      // 工具调用
      callTool: callToolFn,

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
  }
}
