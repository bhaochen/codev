/**
 * /benchmark —— headless（-p / 非交互）模式。
 * 与交互式命令一致的子命令：
 *   benchmark           对当前模型跑 benchmark 并把维度图存入历史（默认）
 *   benchmark show     直接显示已保存的雷达图（各模型一条彩色线）
 *   benchmark clear    清空所有历史
 */
import { buildReportText, parseBenchmarkArgs, runBenchmark } from './runner.js'
import {
  RADAR_AXES,
  clearHistory,
  loadComparisonSeries,
  loadSavedProfiles,
  renderRadar,
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
    if (sub === 'show') {
      // 显示已保存的雷达图
      const profiles = await loadSavedProfiles()
      if (profiles.length === 0) {
        return {
          type: 'text',
          value:
            'no saved benchmark profiles yet — run `benchmark` to add one',
        }
      }
      return { type: 'text', value: renderRadar(RADAR_AXES, profiles) }
    }
    // 默认（含旧用法 eval）：对当前模型跑 benchmark 并把维度图存入历史
    const parsed = parseBenchmarkArgs(sub === 'eval' ? sp.slice(1).join(' ') : sp.join(' '))
    const run = await runBenchmark({ args: parsed })
    const compare =
      parsed.compare > 0
        ? await loadComparisonSeries(run, parsed.compare).catch(() => [])
        : []
    return { type: 'text', value: buildReportText(run, { compare }) }
  } catch (err) {
    return {
      type: 'text',
      value: `Benchmark failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
