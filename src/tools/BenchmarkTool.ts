/**
 * benchmark —— /benchmark eval 报告的渲染工具（显示用途）。
 *
 * 该工具本身不执行 benchmark（由 /benchmark eval 命令带进度地运行），
 * 仅负责把命令注入的「完整报告」在 transcript 中渲染成：
 *   - 折叠态（默认）：标题 + 关键指标摘要
 *   - 展开态（点击后，verbose=true）：完整报告（指标/表格/折线图/建议/雷达图）
 *
 * 通过声明 isResultTruncated，复用 Messages 的 expandedKeys + verbose
 * 点击展开机制（与 WebFetch 一致）。shouldDefer:true 使其不进入模型初始
 * schema（避免被模型顺手调用），但仍留在 tools 数组中供 findToolByName
 * 在渲染时找到，从而支持点击展开。
 */
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../Tool.js'
import { lazySchema } from '../utils/lazySchema.js'
import { BENCHMARK_DESCRIPTION } from './BenchmarkTool/prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
} from './BenchmarkTool/UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    dataset: z
      .string()
      .describe('benchmark 数据集名（默认 deepsearch-demo）')
      .optional(),
    model: z.string().describe('被测 agent 模型').optional(),
    judgeModel: z.string().describe('LLM-as-judge 模型').optional(),
    maxSteps: z.number().describe('agent 最大搜索步数').optional(),
    limit: z.number().describe('限制评测条目数').optional(),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 报告是纯文本字符串
const outputSchema = lazySchema(() => z.string())
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const BENCHMARK_TOOL_NAME = 'benchmark'

export const BenchmarkTool = buildTool({
  name: BENCHMARK_TOOL_NAME,
  searchHint: 'display a /benchmark eval report (click to expand)',
  // 报告已自限长度，不持久化到磁盘（避免循环引用）
  maxResultSizeChars: Infinity,
  // 不在模型初始 schema 中（仅由 /benchmark eval 命令注入结果渲染），但仍在
  // tools 数组里供 findToolByName 渲染点击展开
  shouldDefer: true,
  async description() {
    return 'Displays a benchmark eval report. Run a benchmark with /benchmark eval to produce the report shown here.'
  },
  userFacingName() {
    return 'Benchmark'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Benchmark ${summary}` : 'Benchmark'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  // 报告在折叠态下被截断，点击展开才显示全文 —— 启用点击展开机制
  isResultTruncated() {
    return true
  },
  toAutoClassifierInput() {
    return ''
  },
  async checkPermissions(_input, _context) {
    return {
      behavior: 'allow',
      updatedInput: _input,
    }
  },
  async prompt() {
    return BENCHMARK_DESCRIPTION
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call() {
    return {
      data: 'Benchmark reports are produced by the /benchmark eval command. Run that command to see the full report here.',
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [{ type: 'text', text: output }],
    }
  },
} satisfies ToolDef<InputSchema, Output>)
