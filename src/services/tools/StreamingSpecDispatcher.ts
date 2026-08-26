/**
 * Streaming Speculative Dispatcher — 从流式 JSON 中增量检测工具调用并投机执行。
 *
 * 对应 spec-ptc 原型的 streaming.py 层。在 LLM 流式输出 tool_use block 时，
 * 当 partial JSON input 变为完整 JSON 对象时，立即投机执行该工具调用。
 * 结果存入 SpecStore，供后续 addTool() 的 claim() 命中。
 *
 * 工作原理：
 * 1. content_block_start → 注册一个 ToolBlockTracker
 * 2. 每个 input_json_delta → feed 到 tracker
 * 3. tracker 检测到 input 是完整 JSON → 尝试投机 dispatch
 * 4. content_block_stop → 清理 tracker
 */
import { findToolByName, type Tools } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { isSpeculatable, specKey, type SpecStore, type BudgetTracker } from './speculation.js'

/**
 * 跟踪单个 tool_use block 的 partial JSON 累积过程。
 * 使用 brace depth tracking 检测 input JSON 何时完整。
 */
class ToolBlockTracker {
  /** 当前追踪的 input JSON 字符串 */
  private inputJson = ''
  /** {} 括号嵌套深度（跟踪在顶层 input JSON 对象中） */
  private depth = 0
  /** 是否正在 JSON 字符串值内（"...\n..."跨 delta） */
  private inString = false
  /** 上一个字符是否为转义符 */
  private escaped = false
  /** input 是否已确认为完整 JSON */
  private done = false
  /** 工具名（从 content_block_start 获取） */
  readonly toolName: string

  constructor(toolName: string) {
    this.toolName = toolName
  }

  /**
   * 喂入一个 partial_json delta 片段。
   * 返回 true 如果 input JSON 刚刚变为完整。
   */
  feed(delta: string): boolean {
    if (this.done) return false

    const prevLen = this.inputJson.length
    this.inputJson += delta

    // 增量扫描新增的字符，更新 depth/inString/escaped
    for (let i = prevLen; i < this.inputJson.length; i++) {
      const ch = this.inputJson[i]!

      if (this.escaped) {
        this.escaped = false
        continue
      }

      if (ch === '\\' && this.inString) {
        this.escaped = true
        continue
      }

      if (ch === '"') {
        this.inString = !this.inString
        continue
      }

      if (this.inString) continue

      if (ch === '{' || ch === '[') {
        this.depth++
      } else if (ch === '}' || ch === ']') {
        this.depth--
      }
    }

    // depth 回到 0 表示顶层 JSON 对象/数组已完整
    if (this.depth <= 0 && this.inputJson.length > 0) {
      this.done = true
      return true
    }

    return false
  }

  /** 获取当前累积的 JSON 字符串 */
  getInputJson(): string {
    return this.inputJson
  }

  /** 是否已完成 */
  isDone(): boolean {
    return this.done
  }
}

/**
 * 流式投机调度器。在 streaming loop 中检测 partial JSON 并投机执行工具。
 */
export class StreamingSpecDispatcher {
  /** index → tracker 映射，跟踪每个 content block 的 JSON 累积 */
  private trackers = new Map<number, ToolBlockTracker>()
  private dispatched = 0

  constructor(
    private readonly toolDefinitions: Tools,
    private readonly specStore: SpecStore,
    private readonly budget: BudgetTracker,
  ) {}

  /**
   * content_block_start 时调用。注册新 tool block 的追踪器。
   */
  onBlockStart(index: number, toolName: string): void {
    this.trackers.set(index, new ToolBlockTracker(toolName))
  }

  /**
   * input_json_delta 时调用。检测 input JSON 是否已完整，
   * 如果完整且工具可投机，立即 dispatch。
   */
  onInputDelta(index: number, partialJson: string): boolean {
    const tracker = this.trackers.get(index)
    if (!tracker || tracker.isDone()) return false

    const completed = tracker.feed(partialJson)
    if (!completed) return false

    // JSON 已完整 — 尝试投机 dispatch
    return this.tryDispatch(index, tracker)
  }

  /**
   * content_block_stop 时调用。清理 tracker。
   */
  onBlockStop(index: number): void {
    this.trackers.delete(index)
  }

  /**
   * 尝试对完整的 tool input 进行投机 dispatch。
   */
  private tryDispatch(index: number, tracker: ToolBlockTracker): boolean {
    const toolName = tracker.toolName
    const toolDef = findToolByName(this.toolDefinitions, toolName)
    if (!toolDef) return false

    // 只对 speculatable + pure 的工具投机
    if (!isSpeculatable(toolDef)) return false

    // 预算检查
    if (!this.budget.canDispatch(this.specStore)) return false

    // 尝试 parse input JSON
    let parsedInput: Record<string, unknown>
    try {
      const raw = JSON.parse(tracker.getInputJson())
      if (!raw || typeof raw !== 'object') return false
      parsedInput = raw
    } catch {
      // JSON 不完整或无效 — 跳过
      return false
    }

    // 校验 input schema
    const schemaResult = toolDef.inputSchema.safeParse(parsedInput)
    if (!schemaResult.success) return false

    // 创建投机 key
    const key = specKey(toolName, schemaResult.data)

    // 尝试 claim — 如果 store 中已有相同 key 的 dispatch（不太可能，但防重）
    const existingHit = this.specStore.claim(key)
    if (existingHit) {
      // 已有结果，不需要再 dispatch
      return false
    }

    // 投机 dispatch：异步执行工具并存入 store
    this.budget.recordDispatch()
    this.dispatched++

    const specPromise = this.executeToolSpeculatively(
      toolDef,
      schemaResult.data,
    )
    this.specStore.dispatch(key, specPromise)

    logForDebugging(
      `[spec-ptc] STREAM-DISPATCH ${toolName}#${key.argsHash.slice(0, 8)}`,
    )

    return true
  }

  /**
   * 投机执行工具调用。返回 Promise<string>（结果文本）。
   */
  private async executeToolSpeculatively(
    toolDef: ReturnType<typeof findToolByName> & {},
    input: Record<string, unknown>,
  ): Promise<string> {
    try {
      const result = await toolDef.call(
        input,
        // 最小化 toolUseContext — 投机执行只需要基本字段
        {
          abortController: new AbortController(),
          options: {} as any,
          readFileState: { get: () => undefined, set: () => {} } as any,
          getAppState: () => ({}) as any,
          setAppState: () => {},
          setInProgressToolUseIDs: () => {},
          setResponseLength: () => {},
          updateFileHistoryState: () => {},
          updateAttributionState: () => {},
          messages: [],
        } as any,
        // 自动允许所有投机工具调用
        async () => ({ behavior: 'allow' as const }),
        undefined, // parentMessage
      )

      // 序列化结果
      if (
        typeof result === 'object' &&
        result !== null &&
        'data' in result
      ) {
        const data = (result as { data: unknown }).data
        return typeof data === 'string'
          ? data
          : JSON.stringify(data, null, 2)
      }
      if (typeof result === 'string') return result
      return JSON.stringify(result, null, 2)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error: ${msg}`
    }
  }

  /** 本次流式过程中投机 dispatch 的次数 */
  getDispatchedCount(): number {
    return this.dispatched
  }
}
