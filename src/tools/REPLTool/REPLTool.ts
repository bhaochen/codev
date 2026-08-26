/**
 * REPL Tool — 在 VM 沙箱中执行 JavaScript 代码。
 *
 * 可调用 primitive tools（Read, Write, Edit, Glob, Grep, Bash），
 * 状态跨 turn 持久化。isTransparentWrapper=true 使 REPL 本身不可见，
 * 只显示内部工具调用的进度和结果。
 */
import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import type {
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { lazySchema } from '../../utils/lazySchema.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { REPL_TOOL_NAME } from './constants.js'
import { getReplPrimitiveTools } from './primitiveTools.js'
import { ReplEngine } from './engine.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z
      .string()
      .describe(
        'JavaScript code to execute in the REPL. Can call tools via callTool(name, input). Example: const r = await callTool("read", {file_path: "/tmp/a.txt"}); console.log(r.data)',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type REPLInput = z.infer<InputSchema>

type REPLOutput = { result: string; tool_calls: number }

/** 会话级引擎缓存：同一会话内 VM 上下文持久化，变量绑定跨 turn 保留 */
const engineCache = new Map<string, ReplEngine>()

function getEngine(
  sessionId: string,
  context: ToolUseContext,
): ReplEngine {
  let engine = engineCache.get(sessionId)
  if (!engine) {
    engine = new ReplEngine(getReplPrimitiveTools(), context)
    engineCache.set(sessionId, engine)
  }
  // 更新 toolUseContext（每次 turn 可能变化）
  engine.updateContext(context)
  return engine
}

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  searchHint: 'repl execute batch code read write edit glob grep bash',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return 'Execute JavaScript in the REPL with access to primitive tools (Read, Write, Edit, Glob, Grep, Bash)'
  },
  async prompt() {
    return `Execute JavaScript in the REPL — a sandboxed environment with direct access to primitive tools (Read, Write, Edit, Glob, Grep, Bash).

When REPL mode is active, primitive tools are only accessible through this tool. Use REPL for:
- Batch operations across many files
- Complex multi-step file transformations
- Operations that benefit from programmatic control flow
- Combining search results with edits in a single turn

The REPL runs in a VM context with tool APIs available as functions. Use \`await callTool(name, input)\` to call tools. Results include { data, toolName, isError }.

Example:
\`\`\`js
const files = await callTool("glob", { pattern: "**/*.ts" });
console.log("Found files:", files.data);
const content = await callTool("read", { file_path: "src/index.ts" });
console.log(content.data.slice(0, 200));
\`\`\`

State persists across calls — variables set in one call are available in the next.`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isTransparentWrapper() {
    return true
  },

  userFacingName() {
    return 'REPL'
  },

  renderToolUseMessage(input: Partial<REPLInput>) {
    const code = input.code ?? ''
    const preview = code.length > 80 ? code.slice(0, 77) + '...' : code
    return `REPL: ${preview}`
  },

  mapToolResultToToolResultBlockParam(
    content: REPLOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.result,
    }
  },

  async call(input: REPLInput, context: ToolUseContext, _canUseTool, _parentMessage, onProgress?) {
    // 使用 agentId 或 conversation ID 作为会话标识
    const sessionId = 'default'

    const engine = getEngine(sessionId, context)

    const result = await engine.execute(
      input.code,
      context.toolUseId ?? '',
      (data) => {
        onProgress?.({
          toolUseID: context.toolUseId ?? '',
          data: {
            type: 'repl_tool_call',
            phase: data.phase,
            toolName: data.toolName,
            toolInput: data.toolInput,
          } as any,
        })
      },
    )

    return {
      data: {
        result: result.result,
        tool_calls: result.toolCalls,
      } satisfies REPLOutput,
      newMessages: result.innerMessages as (AssistantMessage | UserMessage)[],
    }
  },
})
