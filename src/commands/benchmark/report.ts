/**
 * /benchmark —— 报告文本构建器。
 *
 * 产出可直接注入对话区（transcript）的文本：聚合指标、每问表格、
 * context 增长折线图（asciichart）、LongSeeker 建议。headless 模式复用。
 */
import { plot as asciichart } from 'asciichart'
import { analyzeContextFromSteps } from './ctx.js'
import { RADAR_AXES, radarSeriesFromRun, renderRadar, type RadarSeries } from './radar.js'
import type { BenchmarkRun, Trajectory } from './types.js'

/** 聚合指标 */
export type RunMetrics = {
  correct: number
  total: number
  accuracyPct: number
  avgScore: number
  avgSteps: number
  avgCtxTokens: number
  avgTokensIn: number
  avgTokensOut: number
  avgTimeSec: number
  peakCtxTokens: number
  honestAnswers: number // 在 maxSteps 内自然产出 <answer> 的比例
}

export function metricsOf(run: BenchmarkRun): RunMetrics {
  const total = Math.max(1, run.trajectories.length)
  const judged = run.trajectories.filter(t => t.judged !== null)
  const correct = judged.filter(t => t.judged?.correct).length
  const acc = (correct / total) * 100

  let sumScore = 0
  let sumSteps = 0
  let sumCtx = 0
  let sumTin = 0
  let sumTout = 0
  let sumTime = 0
  let peak = 0
  let honest = 0
  for (const t of run.trajectories) {
    sumScore += t.judged?.score ?? 0
    sumSteps += Math.max(1, t.steps.length)
    const ctx = t.steps.at(-1)?.contextTokensAfter ?? 0
    sumCtx += ctx
    peak = Math.max(peak, ...t.steps.map(s => s.contextTokensAfter))
    sumTin += t.steps.reduce((a, s) => a + s.llmTokensIn, 0)
    sumTout += t.steps.reduce((a, s) => a + s.llmTokensOut, 0)
    sumTime += t.durationMs
    if (t.naturallyAnswered) honest += 1
  }
  return {
    correct,
    total,
    accuracyPct: acc,
    avgScore: sumScore / total,
    avgSteps: sumSteps / total,
    avgCtxTokens: sumCtx / total,
    avgTokensIn: sumTin / total,
    avgTokensOut: sumTout / total,
    avgTimeSec: sumTime / total / 1000,
    peakCtxTokens: peak,
    honestAnswers: (honest / total) * 100,
  }
}

/** 每问一行 */
export function questionTableLines(run: BenchmarkRun): string[] {
  const lines: string[] = []
  const hdr =
    `${'ID'.padEnd(22)} c  score  st  ctx(k)  in(tok)  out(tok)  time(s)`
  lines.push(hdr)
  lines.push('─'.repeat(hdr.length))
  for (const t of run.trajectories) {
    const mark = t.judged === null ? '·' : t.judged.correct ? '✔' : '✘'
    const score = t.judged === null ? '—' : t.judged.score.toFixed(1)
    const ctx = ((t.steps.at(-1)?.contextTokensAfter ?? 0) / 1000).toFixed(1)
    const tin = t.steps.reduce((a, s) => a + s.llmTokensIn, 0)
    const tout = t.steps.reduce((a, s) => a + s.llmTokensOut, 0)
    const sec = (t.durationMs / 1000).toFixed(1)
    lines.push(
      `${t.id.padEnd(22)} ${mark} ${score.padStart(5)} ${String(t.steps.length).padStart(3)} ${ctx.padStart(6)} ${String(tin).padStart(8)} ${String(tout).padStart(9)} ${sec.padStart(7)}`,
    )
    if (t.error) lines.push(`  note: ${t.error}`)
  }
  return lines
}

/**
 * context 增长折线图（LongSeeker 关心的长程 context 曲线）。
 * 单问多 series 对比 + 若 >=2 问附带总体均值 series（虚线标注平均）。
 */
export function contextGrowthChart(
  trajectories: Trajectory[],
  opts: { height?: number } = {},
): string {
  const height = opts.height ?? 8
  if (trajectories.length === 0) return '(no data)'

  const maxSteps = Math.max(1, ...trajectories.map(t => t.steps.length))
  const series: number[][] = []
  for (const t of trajectories) {
    const values: number[] = []
    for (let i = 1; i <= maxSteps; i++) {
      const step = t.steps.find(s => s.step === i)
      values.push(step?.contextTokensAfter ?? values.at(-1) ?? 0)
    }
    series.push(values)
  }
  // 总体均值 line
  if (trajectories.length >= 2) {
    const avg: number[] = []
    for (let i = 0; i < maxSteps; i++) {
      const sum = series.reduce((a, s) => a + (s[i] ?? 0), 0)
      avg.push(sum / series.length)
    }
    series.push(avg)
  }

  const labels = series.map((_, i) =>
    i === series.length - 1 && trajectories.length >= 2 ? 'avg' : labelsShort(trajectories[i % Math.min(series.length, Math.max(1, trajectories.length))]?.id)
  )

  const chart = asciichart(series, {
    height,
    format: fmtTokens,
  })
  const legend = series
    .map((_, i) =>
      i === series.length - 1 && trajectories.length >= 2
        ? '· avg'
        : `· ${labels[i]}`,
    )
    .join('   ')

  const xAxis = xAxisLabels(maxSteps)
  return `${chart}\n${' '.repeat(6)}${legend}\n${xAxis}`
}

function labelsShort(id: string | undefined): string {
  if (!id) return '?'
  return id.length > 12 ? `${id.slice(0, 11)}…` : id
}

function fmtTokens(x: number): string {
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}k`
  return String(Math.round(x)).padStart(8)
}

function xAxisLabels(steps: number): string {
  const axis = new Array(steps).fill('').map((_, i) => `${i + 1}`)
  // 太密就隔号显示
  const showEvery = steps > 12 ? 2 : steps > 6 ? 1 : 1
  return `step  ${axis.map((v, i) => (i % showEvery === 0 ? ` ${v}` : '  ')).join('')}`
}

/** LongSeeker 建议块 */
export function suggestionsLines(run: BenchmarkRun): string[] {
  const lines: string[] = []
  let any = false
  for (const t of run.trajectories) {
    const analysis = analyzeContextFromSteps(t)
    for (const s of analysis.suggestions) {
      any = true
      lines.push(
        `  ${t.id} · ${s.kind} @step ${s.step} (${s.contextTokens.toLocaleString()} tok): ${s.reason}`,
      )
    }
    if (analysis.peakTokens > 15_000 && analysis.suggestions.length === 0) {
      any = true
      lines.push(
        `  ${t.id} · context peaked at ${(analysis.peakTokens / 1000).toFixed(1)}k tok but no meta-op flagged — candidate for compression review`,
      )
    }
  }
  if (!any) lines.push('  none — context stayed small')
  return lines
}

/**
 * ABSeeker 步级打分明细（训练信号：哪一步 anchor / 有用 / 有害，逐 token 计分）。
 * 无打分数据时返回占位行。
 */
export function stepScoreLines(run: BenchmarkRun): string[] {
  const lines: string[] = []
  for (const t of run.trajectories) {
    if (t.stepScores.length === 0) continue
    const parts = t.stepScores.map(s => {
      const mark = s.isAnchor
        ? '◆'
        : s.verdict === 'harmful'
          ? '✗'
          : s.verdict === 'essential'
            ? '●'
            : s.verdict === 'useful'
              ? '+'
              : '·'
      const sign = s.score >= 0 ? '+' : ''
      return `${s.step}:${s.action} ${sign}${s.score.toFixed(1)}${mark}`
    })
    lines.push(`  ${t.id} · ${parts.join('  ')}`)
  }
  if (lines.length === 0) lines.push('  n/a — enable step scoring')
  return lines
}

/** 存活渲染：运行中/阶段切换时注入对话区的紧凑行 */
export function buildLiveProgressText(p: {
  phase: string
  datasetName: string
  total: number
  current: number
  currentId: string
  currentQuery: string
  currentSteps: number
  currentCtxTokens: number
  currentAction: string
  message?: string
}): string {
  if (p.phase === 'loading' || !p.current) {
    return `benchmark${p.message ? ` — ${p.message}` : ''}`
  }
  const action =
    p.currentAction === 'search_web'
      ? 'searching'
      : p.currentAction === 'visit_web'
        ? 'reading page'
        : p.currentAction === 'answer'
          ? 'answering'
          : p.currentAction === 'judge'
            ? 'judging'
            : p.currentAction === 'score'
              ? 'scoring steps'
              : p.currentAction
  const ctx = ((p.currentCtxTokens ?? 0) / 1000).toFixed(1)
  return `(${p.current}/${p.total}) ${p.currentId} · step ${p.currentSteps} · ${action} · ctx ${ctx}k tok`
}

/** 最终报告（注入对话区的完整块） */
export function buildInlineReport(
  run: BenchmarkRun,
  opts: { compare?: RadarSeries[] } = {},
): string {
  const m = metricsOf(run)
  const lines: string[] = []
  lines.push(`deepsearch benchmark report — ${run.datasetName}`)
  lines.push(
    `agent: ${run.model}${run.judgeModel && run.judgeModel !== run.model ? `   judge: ${run.judgeModel}` : ''}   max-steps: ${run.maxSteps}   saved: ${run.runDir}`,
  )
  lines.push('')
  lines.push('▍metrics')
  lines.push(
    `  accuracy      ${m.correct}/${m.total} (${m.accuracyPct.toFixed(1)}%)`,
  )
  lines.push(`  avg score     ${m.avgScore.toFixed(2)} / 10`)
  lines.push(
    `  avg steps     ${m.avgSteps.toFixed(1)}   (naturally answered ${m.honestAnswers.toFixed(0)}%)`,
  )
  lines.push(
    `  avg ctx       ${(m.avgCtxTokens / 1000).toFixed(1)}k tok   peak ${(m.peakCtxTokens / 1000).toFixed(1)}k tok`,
  )
  lines.push(
    `  avg tokens    ${Math.round(m.avgTokensIn).toLocaleString()} in / ${Math.round(m.avgTokensOut).toLocaleString()} out per question`,
  )
  lines.push(`  avg latency   ${m.avgTimeSec.toFixed(1)}s per question`)
  lines.push('')
  lines.push('▍per-question')
  lines.push(...questionTableLines(run))
  lines.push('')
  lines.push('▍step scores (ABSeeker per-step credit)')
  lines.push(...stepScoreLines(run))
  lines.push('')
  lines.push('▍context growth per step (tok)')
  lines.push(contextGrowthChart(run.trajectories))
  lines.push('')
  lines.push('▍context meta-op suggestions (LongSeeker)')
  lines.push(...suggestionsLines(run))
  lines.push('')
  lines.push('▍radar — multi-dimensional profile (shared scale, ↑ = better)')
  const series = [radarSeriesFromRun(run), ...(opts.compare ?? [])]
  lines.push(renderRadar(RADAR_AXES, series))
  return lines.join('\n')
}