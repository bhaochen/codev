/**
 * /benchmark —— 多维雷达图（参考 Kiln 的 compare_radar_chart）。
 *
 * Kiln 用 ECharts 在浏览器里画雷达图：每根轴 = 一个评测维度，每个多边形 =
 * 一个 run config，lower-is-better 的维度（成本/延迟）被反转为「越大越好」。
 *
 * codev 是终端 CLI（Ink/文本），无法直接用 ECharts，所以这里把同一套思路
 * 移植成 ASCII 雷达图：
 *  - 每根轴 = 一个 benchmark 维度（准确率 / 均分 / 效率 / 速度…）
 *  - 每个多边形 = 一次运行（当前 run + 可叠加历史 run，对应 Kiln 的 compare）
 *  - lower-is-better 的维度按固定参考上限反转为「越大越高效」
 *  - 多 run 共享同一绝对刻度，直接可比（Kiln 是按对比集内最大值归一，这里用
 *    固定参考上限 + 必要时抬升到对比集最大值，刻度更稳定可读）
 *
 * 纯函数、无副作用，便于单元测试；比较用的历史 run 由 loadComparisonSeries 读取。
 */
import { basename, dirname, join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { metricsOf, type RunMetrics } from './report.js'
import type { BenchmarkRun } from './types.js'

/** 一根雷达轴（一个评测维度） */
export type RadarAxis = {
  key: string
  /** 图内 / 图例显示名 */
  label: string
  /** 参考上限（绝对刻度天花板） */
  max: number
  /** true 表示原始值越小越好，渲染时反转为「越大越高效」 */
  lowerIsBetter: boolean
  /** 原始值的人类可读格式（用于图例） */
  formatRaw: (v: number) => string
}

function fmtTok(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v.toFixed(0)
}

/**
 * 雷达图的维度定义。
 * 前 3 个为质量维度（越高越好），后 4 个为效率/速度维度（越低越好 → 反转）。
 */
export const RADAR_AXES: RadarAxis[] = [
  { key: 'accuracy', label: 'Accuracy', max: 100, lowerIsBetter: false, formatRaw: v => `${v.toFixed(0)}%` },
  { key: 'score', label: 'Avg Score', max: 10, lowerIsBetter: false, formatRaw: v => `${v.toFixed(1)}/10` },
  { key: 'honest', label: 'Honest Rate', max: 100, lowerIsBetter: false, formatRaw: v => `${v.toFixed(0)}%` },
  { key: 'steps', label: 'Step Eff.', max: 16, lowerIsBetter: true, formatRaw: v => `${v.toFixed(0)} steps` },
  { key: 'ctx', label: 'Ctx Eff.', max: 40_000, lowerIsBetter: true, formatRaw: v => `${fmtTok(v)} tok` },
  { key: 'tokens', label: 'Token Eff.', max: 120_000, lowerIsBetter: true, formatRaw: v => `${fmtTok(v)} tok` },
  { key: 'speed', label: 'Speed', max: 60, lowerIsBetter: true, formatRaw: v => `${v.toFixed(1)}s` },
]

/** 一条雷达序列（一次运行） */
export type RadarSeries = {
  name: string
  /** 与 RADAR_AXES 顺序对齐的原始值 */
  values: number[]
}

/** 从一次完整 run 构造序列 */
export function radarSeriesFromRun(run: BenchmarkRun, name?: string): RadarSeries {
  const m = metricsOf(run)
  return {
    name: name ?? run.model,
    values: [
      m.accuracyPct,
      m.avgScore,
      m.honestAnswers,
      m.avgSteps,
      m.avgCtxTokens,
      m.avgTokensIn + m.avgTokensOut,
      m.avgTimeSec,
    ],
  }
}

/** 从已落盘的 metrics（历史 run）构造序列 */
export function radarSeriesFromMetrics(m: RunMetrics, name: string): RadarSeries {
  return {
    name,
    values: [
      m.accuracyPct,
      m.avgScore,
      m.honestAnswers,
      m.avgSteps,
      m.avgCtxTokens,
      m.avgTokensIn + m.avgTokensOut,
      m.avgTimeSec,
    ],
  }
}

/** 归一化结果：每条序列每轴一个 0..1 的分值 */
export type RadarNorm = { norm: number[][]; bounds: number[] }

/**
 * 把原始值归一化到 0..1：
 *  - 每轴取 max(参考上限, 对比集内最大值) 作为刻度上限（刻度稳定且能容纳异常大值）
 *  - 普通维度：norm = raw / bound
 *  - lowerIsBetter：norm = 1 - raw / bound（值越小 → 越接近 1 → 半径越大）
 */
export function radarNormalize(axes: RadarAxis[], series: RadarSeries[]): RadarNorm {
  const bounds = axes.map((ax, i) => {
    let mx = ax.max
    for (const s of series) mx = Math.max(mx, s.values[i] ?? 0)
    return mx
  })
  const norm = series.map(s =>
    axes.map((ax, i) => {
      const raw = s.values[i] ?? 0
      let f = bounds[i] ? raw / bounds[i] : 0
      f = Math.max(0, Math.min(1, f))
      if (ax.lowerIsBetter) f = 1 - f
      return f
    }),
  )
  return { norm, bounds }
}

const PALETTE = ['■', '□', '▲', '△', '◆', '●', '★', '✦']
const GRID = '.'
const SPOKE = '·'
const LETTER_BASE = 65 // 'A'

export type RadarOptions = { radius?: number; rings?: number }

/**
 * 渲染 ASCII 雷达图本体（不含图例）。
 * 通过字符网格 + Bresenham 画线实现：同心多边形网格 + 放射轴 + 叠加的序列多边形。
 * 纵向半径取横向的一半以补偿终端字符约 2:1 的宽高比，使多边形视觉上接近圆形。
 */
export function renderRadarChart(
  axes: RadarAxis[],
  series: RadarSeries[],
  opts: RadarOptions = {},
): string {
  const N = axes.length
  if (N < 3) return '(need ≥3 axes for radar)'
  const R = opts.radius ?? 22
  const Ry = Math.max(4, Math.round(R / 2))
  const rings = opts.rings ?? 4
  const cx = R + 1
  const cy = Ry + 1
  const W = 2 * R + 3
  const H = 2 * Ry + 3
  const grid: string[][] = Array.from({ length: H }, () => new Array<string>(W).fill(' '))

  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / N
  const point = (i: number, frac: number): [number, number] => [
    Math.round(cx + Math.cos(angle(i)) * R * frac),
    Math.round(cy + Math.sin(angle(i)) * Ry * frac),
  ]
  const set = (x: number, y: number, ch: string) => {
    if (y >= 0 && y < H && x >= 0 && x < W) grid[y]![x] = ch
  }
  const line = (x0: number, y0: number, x1: number, y1: number, ch: string) => {
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    let x = x0
    let y = y0
    for (;;) {
      set(x, y, ch)
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x += sx
      }
      if (e2 < dx) {
        err += dx
        y += sy
      }
    }
  }

  // 同心多边形网格
  for (let r = 1; r <= rings; r++) {
    const frac = r / rings
    for (let i = 0; i < N; i++) {
      const [x1, y1] = point(i, frac)
      const [x2, y2] = point((i + 1) % N, frac)
      line(x1, y1, x2, y2, GRID)
    }
  }
  // 放射轴（中心 → 各轴顶点）
  for (let i = 0; i < N; i++) {
    const [x, y] = point(i, 1)
    line(cx, cy, x, y, SPOKE)
  }
  // 序列多边形（叠加，每个序列一个字符）
  const { norm } = radarNormalize(axes, series)
  series.forEach((_s, si) => {
    const ch = PALETTE[si % PALETTE.length]!
    const verts = norm[si]!.map((f, i) => point(i, f)) as [number, number][]
    for (let i = 0; i < N; i++) {
      const [x1, y1] = verts[i]!
      const [x2, y2] = verts[(i + 1) % N]!
      line(x1, y1, x2, y2, ch)
    }
    for (const [x, y] of verts) set(x, y, ch)
  })
  // 轴顶点字母（A/B/C…，覆盖在最上层做方位标记）
  for (let i = 0; i < N; i++) {
    const [x, y] = point(i, 1)
    set(x, y, String.fromCharCode(LETTER_BASE + i))
  }
  set(cx, cy, '+')

  return grid.map(row => row.join('').replace(/\s+$/, '')).join('\n')
}

/**
 * 渲染图例 + 每轴数值表。
 * 当前 run（序列 0）显示归一化百分比 + 原始值；其余对比 run 只显示百分比，
 * 方便在同一刻度上横向比较。
 */
export function renderRadarLegend(axes: RadarAxis[], series: RadarSeries[]): string {
  const { norm } = radarNormalize(axes, series)
  const lines: string[] = []
  const names = series.map(
    (s, i) => `${PALETTE[i % PALETTE.length]} ${truncate(s.name, 20)}`,
  )
  lines.push(`  ${names.join('   ')}`)
  lines.push('')
  axes.forEach((ax, i) => {
    const letter = String.fromCharCode(LETTER_BASE + i)
    const cells = series.map((s, si) => {
      const f = norm[si]![i]!
      const pct = `${Math.round(f * 100)}%`
      if (si === 0) return `${pct} (${ax.formatRaw(s.values[i] ?? 0)})`
      return pct
    })
    lines.push(`  ${letter} ${ax.label.padEnd(11)} ${cells.join('   ')}`)
  })
  return lines.join('\n')
}

/** 雷达图 + 图例的完整区块 */
export function renderRadar(
  axes: RadarAxis[],
  series: RadarSeries[],
  opts: RadarOptions = {},
): string {
  return `${renderRadarChart(axes, series, opts)}\n\n${renderRadarLegend(axes, series)}`
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * 读取同一 dataset 下的历史 run（来自 .codev-benchmarks/<run>/eval_results.json），
 * 构造可叠加的对比序列。跳过当前 run 与缺 metrics 的旧 run。
 * 对应 Kiln compare 页「Compare Run Configurations」里选取多个 run config 叠加。
 */
export async function loadComparisonSeries(
  run: BenchmarkRun,
  limit = 4,
): Promise<RadarSeries[]> {
  const base = dirname(run.runDir)
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return []
  }
  const self = basename(run.runDir)
  const candidates: { metrics: RunMetrics; name: string }[] = []
  for (const name of entries) {
    if (name === self || name === '') continue
    try {
      const raw = await readFile(join(base, name, 'eval_results.json'), 'utf8')
      const data = JSON.parse(raw) as {
        dataset?: string
        model?: string
        startedAt?: string
        metrics?: RunMetrics
      }
      if (data.dataset !== run.datasetName) continue
      if (!data.metrics) continue
      candidates.push({
        metrics: data.metrics,
        name: shortRunName(data.model ?? '?', data.startedAt ?? ''),
      })
    } catch {
      // 非 run 目录或不可读 → 跳过
    }
  }
  // 最近的优先
  candidates.sort((a, b) => b.name.localeCompare(a.name))
  return candidates.slice(0, limit).map(c => radarSeriesFromMetrics(c.metrics, c.name))
}

function shortRunName(model: string, startedAt: string): string {
  const d = startedAt ? startedAt.slice(0, 10) : '?'
  const m = model.split('/').pop() ?? model
  return `${m} ${d}`
}
