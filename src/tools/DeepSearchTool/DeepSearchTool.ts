/**
 * deepsearch —— deep research benchmark 工具。
 *
 * 复用 /benchmark 的 runner（ReAct 搜索循环 + LLM-as-judge + ABSeeker 步级
 * 打分 + LongSeeker context 分析），把完整报告作为 tool result 返回。
 * 主 agent 可直接调用；/benchmark 命令的最终报告也以同名单工具 result
 * 消息注入对话，保证 UI 渲染一致。
 */
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { runBenchmark, type BenchmarkArgs } from '../../commands/benchmark/runner.js'
import { buildInlineReport } from '../../commands/benchmark/report.js'
import { DEEPSEARCH_TOOL_NAME, DESCRIPTION } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.object({
    dataset: z
      .string()
      .default('deepsearch-demo')
      .describe('Dataset name (builtin "deepsearch-demo") or path to a JSON file of {id, query, gt} objects.'),
    model: z
      .string()
      .optional()
      .describe('Agent (ReAct search loop) model. Defaults to the main loop model.'),
    judgeModel: z
      .string()
      .optional()
      .describe('LLM-as-judge / per-step scoring model. Defaults to the agent model.'),
    maxSteps: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(8)
      .describe('Max search steps per question.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Only run the first N questions.'),
    judge: z.boolean().default(true).describe('Enable LLM-as-judge evaluation.'),
    score: z.boolean().default(true).describe('Enable per-step credit scoring.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() => z.string())

export const DeepSearchTool = buildTool({
  name: DEEPSEARCH_TOOL_NAME,
  searchHint: 'run a deep research benchmark and return its report',
  maxResultSizeChars: 100_000,
  shouldDefer: false,
  async description(input) {
    const { dataset } = input as Input
    return `Run a deep research benchmark on "${dataset}" and return the full report`
  },
  userFacingName() {
    return 'DeepSearch'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const { dataset } = input as Partial<Input>
    return dataset
      ? `Running deepsearch benchmark: ${dataset}`
      : 'Running deepsearch benchmark'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  // 写 .codev-benchmarks/ 落盘 + 长时间运行，不能并发
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input: Input) {
    const args: BenchmarkArgs = {
      dataset: input.dataset,
      model: input.model || getMainLoopModel(),
      judgeModel: input.judgeModel ?? '',
      maxSteps: input.maxSteps,
      limit: input.limit ?? Infinity,
      out: '',
      judge: input.judge,
      score: input.score,
    }
    const run = await runBenchmark({ args })
    return { data: buildInlineReport(run) }
  },
  mapToolResultToToolResultBlockParam(output: string, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    }
  },
} satisfies ToolDef<InputSchema, string>)
