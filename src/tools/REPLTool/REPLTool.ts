/**
 * REPL Tool — 可编程执行环境（VM 沙箱中运行 JavaScript）。
 *
 * 提供 for/while/if/函数/regex/数据结构等完整编程能力，状态跨 turn
 * 持久化；同时可调用 primitive tools（Read, Write, Edit, Glob, Grep, Bash）。
 * 是叠加在普通工具池之上的编程环境，不取代任何直接工具。
 * isTransparentWrapper=true 使 REPL 本身不可见，只显示内部工具调用的
 * 进度和结果。
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
import { getSessionId } from '../../bootstrap/state.js'
import { ReplEngine } from './engine.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z
      .string()
      .describe(
        'JavaScript to run in the REPL programming environment. Write arbitrary logic (loops, conditionals, functions, regex, data processing) and use await callTool(name, input) for file/search/shell access. Variables persist across calls. Result is the expression value / console output, or auto-aggregated JSON of tool calls.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type REPLInput = z.infer<InputSchema>

type REPLOutput = { result: string; tool_calls: number }

/** 会话级引擎缓存：同一会话内 VM 上下文持久化，变量绑定跨 turn 保留 */
const engineCache = new Map<string, ReplEngine>()

function getEngine(context: ToolUseContext): ReplEngine {
  // Isolate each session's VM state: sub-agents carry a unique agentId, while
  // the main thread falls back to the session/conversation id. The previous
  // hardcoded 'default' key let a sub-agent's REPL variables leak into the
  // parent (and sibling) sessions.
  const engineKey = context.agentId ?? getSessionId()
  let engine = engineCache.get(engineKey)
  if (!engine) {
    engine = new ReplEngine(getReplPrimitiveTools(), context)
    engineCache.set(engineKey, engine)
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
    return 'Sandboxed JavaScript programming environment with persistent state; optionally call primitive tools (Read, Write, Edit, Glob, Grep, Bash) from code'
  },
  async prompt() {
    return `Execute JavaScript in the REPL — a sandboxed **programming environment**, not just a tool caller. Write real programs: loops, conditions, helper functions, regex, data structures, arithmetic. Anything you would otherwise "reason about" in tokens can be computed exactly here, and variables persist across calls.

REPL is **additive**: the normal tools (Read, Write, Edit, Glob, Grep, Bash) remain directly callable. Use a direct tool for a single operation. Reach for REPL when a task benefits from programming:
- Batch operations across many files (loop + condition + transform in ONE call instead of N round-trips)
- Multi-step pipelines whose intermediates should stay in VM variables, not bloat your context
- Work that mixes computation with file, search, or shell access

Inside the environment, tools are plain functions via \`await callTool(name, input)\` — each returns { data, toolName, isError }. Results of tool calls are auto-aggregated into structured JSON; console.log is optional extra logging. Pure computation with no tool calls returns the expression value / console output directly.

Execution model (3 layers):
- ToolResult (unified fact): { tool, ok, isError, stdout/stderr/data, exitCode?, truncated?, outputPath?, noOutputExpected? }
- ExecutionStore (innerMessages, isVirtual=true): UI/history only, never sent to LLM API
- ContextAggregator (REPL result): auto-collects every callTool result into structured JSON — you do NOT need console.log to make results visible. console.log is optional extra logging.

Result contract when tool_calls > 0 (structured JSON, always returned):
\`\`\`json
{
  "ok": true,
  "tool_calls": 2,
  "calls": [
    { "tool": "Bash", "ok": true, "exitCode": 0, "preview": "github.com\\n✓ Logged in...", "truncated": false },
    { "tool": "Read", "ok": true, "preview": "file content head...", "truncated": true, "outputPath": "/tmp/..." }
  ],
  "logs": "optional console.log output"
}
\`\`\`
- ok = every call ok && no engine error. Check ok/exitCode/error, never stdout==="" for failure.
- Bash: stdout/stderr merged into preview, noOutputExpected=true means empty is success (mkdir).
- Read: preview truncated to ~4KB, truncated=true + outputPath for full content.
- Grep: preview = matches, truncated if many.
- Write/Edit: summary/preview = diff summary.

Available tools (case-insensitive), callable via callTool:
- "Glob" — find files by pattern. Input: { pattern: "src/**/*.ts" }
- "Grep" — search file contents. Input: { pattern: "regex", path: "src/" }
- "Read" — read file contents. Input: { file_path: "path/to/file" }
- "Write" — write file. Input: { file_path: "path", content: "text" }
- "Edit" — edit file. Input: { file_path: "path", old_string: "a", new_string: "b" }
- "Bash" — run shell command. Input: { command: "ls -la" }

Reliable file-edit helpers are also exposed as globals — they write straight to disk, print a +/- diff of the change, and do not require a prior Read:
- readFile(path) → returns file contents
- writeFile(path, content) → writes file, prints added/removed diff
- editFile(path, old, new, {replaceAll?}) → replaces a string, prints diff
- viewFile(path) → prints the file with line numbers (like Read)
- diffFile(path, ref?) → prints the git working-tree (or vs ref) diff
- showDiff(before, after, filePath?) → unified diff of two strings

Example — program across files (console.log optional):
\`\`\`js
const files = await callTool("Glob", { pattern: "src/**/*.ts" });
const names = files.data ?? [];
const todo = names.filter(n => n.includes("legacy"));
for (const f of todo) {
  const c = await callTool("Read", { file_path: f });
  if (c.data.includes("TODO")) {
    await callTool("Edit", { file_path: f, old_string: "TODO", new_string: "DONE" });
  }
}
const stats = todo.length; // pure computation, returned exactly
\`\`\`

State persists across calls — variables set in one call are available in the next.
Do NOT use require(), import(), eval(), process, Bun, or globalThis — they are blocked.`
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
    const engine = getEngine(context)

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
