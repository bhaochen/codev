/**
 * /benchmark —— headless（-p / 非交互）模式。显示命令，与交互式一致：
 *   benchmark           直接显示已保存的雷达图（各模型一条彩色线，默认）
 *   benchmark show     同默认，直接显示已保存的雷达图
 *   benchmark eval     对当前模型跑 benchmark 并把维度图存入历史
 *   benchmark clear    清空所有历史
 */
import { buildReportText, parseBenchmarkArgs, runBenchmark } from './runner.js'
import {
  RADAR_AXES,
  clearHistory,
  loadComparisonSeries,
  loadSavedProfiles,
  renderRadarReport,
} from './radar.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async (args, context) => {
  void context
  const sp = args.trim().split(/\s+/).filter(Boolean)
  const sub = (sp[0] ?? '').toLowerCase()
  try {
    if (sub === 'clear') {
      const n = await clearHistory()
      return {
        type: 'text',
        value: `cleared ${n} saved benchmark profile${n === 1 ? '' : 's'}`,
      }
    }
    if (sub === 'eval') {
      const parsed = parseBenchmarkArgs(sp.slice(1).join(' '))
      const run = await runBenchmark({ args: parsed })
      const compare =
        parsed.compare > 0
          ? await loadComparisonSeries(run, parsed.compare).catch(() => [])
          : []
      return { type: 'text', value: buildReportText(run, { compare }) }
    }
    // 默认（含 show 别名）：直接显示已保存的雷达图
    const profiles = await loadSavedProfiles()
    if (profiles.length === 0) {
      return {
        type: 'text',
        value:
          'no saved benchmark profiles yet — run `benchmark eval` to add one',
      }
    }
    return { type: 'text', value: renderRadarReport(RADAR_AXES, profiles) }
  } catch (err) {
    return {
      type: 'text',
      value: `Benchmark failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
