/**
 * /benchmark —— headless（-p / 非交互）模式。
 * 跑完整个 benchmark 直接输出文本报告。
 */
import { buildReportText, parseBenchmarkArgs, runBenchmark } from './runner.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async (args, context) => {
  void context
  try {
    const parsed = parseBenchmarkArgs(args)
    const run = await runBenchmark({
      args: parsed,
      // headless 不进 UI，直接等待最终结果
    })
    return { type: 'text', value: buildReportText(run) }
  } catch (err) {
    return {
      type: 'text',
      value: `Benchmark failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}