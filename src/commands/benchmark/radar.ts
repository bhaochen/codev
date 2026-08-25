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
import { basename, dirname, join, resolve } from 'node:path'
import { readdir, readFile, rm } from 'node:fs/promises'
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

export const PALETTE = ['■', '□', '▲', '△', '◆', '●', '★', '✦']
const LETTER_BASE = 65 // 'A'

/**
 * 每根多边形线的颜色。
 * - ANSI 码用于注入 `<Ansi>` 组件渲染（交互式 /benchmark show 命令）
 * - Ink 颜色名用于 React `<Text color>` 图例
 * 顺序一致，保证图与图例颜色对应。
 */
export const RADAR_PALETTE_ANSI = [31, 32, 33, 34, 35, 36, 37, 91, 92, 93, 94, 95, 96, 97]
export const RADAR_PALETTE_INK = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
] as const

export type RadarOptions = { radius?: number; rings?: number; colorize?: boolean }

/**
 * 渲染 ASCII 雷达图本体（不含图例）。
 * 采用 Braille（盲文点阵）栅格：每个字符承载 2×4 点，而盲文点在终端中等宽高比，
 * 因此无需像纯字符网格那样按 2:1 压扁，雷达图视觉上更接近正圆、线条更细更清晰。
 * 参考 MapSCII / Plotille 的终端高分辨率渲染思路。
 * 序列多边形按 series 顺序叠加，颜色与图例一致（同屏各模型颜色互异）。
 */
export function renderRadarChart(
  axes: RadarAxis[],
  series: RadarSeries[],
  opts: RadarOptions = {},
): string {
  const N = axes.length
  if (N < 3) return '(need ≥3 axes for radar)'
  const R = opts.radius ?? 22 // 半径（盲文点）
  const rings = opts.rings ?? 3
  const M = 6 // 外圈留白，用于放置轴字母
  const cx = R + M
  const cy = R + M
  const WD = 2 * cx + 8 // 点阵宽
  const HD = 2 * cy + 6 // 点阵高
  const Wc = Math.ceil(WD / 2)
  const Hc = Math.ceil(HD / 4)
  const dots = new Uint8Array(WD * HD)
  const cellColor: (number | null)[] = new Array(Wc * Hc).fill(null)
  const labels: (string | null)[] = new Array(Wc * Hc).fill(null)

  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / N
  const fx = (i: number, frac: number) => cx + Math.cos(angle(i)) * R * frac
  const fy = (i: number, frac: number) => cy + Math.sin(angle(i)) * R * frac

  const setDot = (dx: number, dy: number, ci: number | null) => {
    if (dx < 0 || dx >= WD || dy < 0 || dy >= HD) return
    dots[dy * WD + dx] = 1
    if (ci != null) cellColor[(dy >> 2) * Wc + (dx >> 1)] = ci
  }
  const bline = (
    x0: number, y0: number, x1: number, y1: number, ci: number | null,
  ) => {
    let x = Math.round(x0)
    let y = Math.round(y0)
    const X = Math.round(x1)
    const Y = Math.round(y1)
    const dx = Math.abs(X - x)
    const dy = Math.abs(Y - y)
    const sx = x < X ? 1 : -1
    const sy = y < Y ? 1 : -1
    let err = dx - dy
    for (;;) {
      setDot(x, y, ci)
      if (x === X && y === Y) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; x += sx }
      if (e2 < dx) { err += dx; y += sy }
    }
  }

  // 同心多边形网格（无颜色，作为底纹）
  for (let r = 1; r <= rings; r++) {
    const frac = r / rings
    for (let i = 0; i < N; i++) {
      bline(
        fx(i, frac), fy(i, frac),
        fx((i + 1) % N, frac), fy((i + 1) % N, frac),
        null,
      )
    }
  }
  // 放射轴（中心 → 各轴顶点）
  for (let i = 0; i < N; i++) bline(cx, cy, fx(i, 1), fy(i, 1), null)
  // 序列多边形（叠加，按 series 顺序分配颜色）
  const { norm } = radarNormalize(axes, series)
  series.forEach((_s, si) => {
    const ci = si
    const verts = norm[si]!.map((f, i) => [fx(i, f), fy(i, f)] as [number, number])
    for (let i = 0; i < N; i++) {
      const [x1, y1] = verts[i]!
      const [x2, y2] = verts[(i + 1) % N]!
      bline(x1, y1, x2, y2, ci)
    }
    for (const [x, y] of verts) setDot(Math.round(x), Math.round(y), ci)
  })
  // 轴顶点字母（置于外圈外侧）
  for (let i = 0; i < N; i++) {
    const lx = Math.round(fx(i, 1.16))
    const ly = Math.round(fy(i, 1.16))
    if (lx >= 0 && lx < WD && ly >= 0 && ly < HD) {
      labels[(ly >> 2) * Wc + (lx >> 1)] = String.fromCharCode(LETTER_BASE + i)
    }
  }
  labels[(cy >> 2) * Wc + (cx >> 1)] = '+'

  const BRAILLE_BIT = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
  ]
  const rows: string[] = []
  for (let r = 0; r < Hc; r++) {
    let line = ''
    for (let c = 0; c < Wc; c++) {
      const idx = r * Wc + c
      const label = labels[idx]
      if (label) {
        line += label
        continue
      }
      let bits = 0
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 2; col++) {
          const dx = c * 2 + col
          const dy = r * 4 + row
          if (dots[dy * WD + dx]) bits |= BRAILLE_BIT[row]![col]!
        }
      }
      if (bits === 0) {
        line += ' '
      } else {
        const ch = String.fromCharCode(0x2800 + bits)
        const ci = cellColor[idx]
        if (opts.colorize && ci != null) {
          const code = RADAR_PALETTE_ANSI[ci % RADAR_PALETTE_ANSI.length]!
          line += `\x1b[${code}m${ch}\x1b[0m`
        } else {
          line += ch
        }
      }
    }
    rows.push(line.replace(/\s+$/, ''))
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  while (rows.length && rows[0] === '') rows.shift()
  return rows.join('\n')
}

/**
 * 渲染「每轴 × 各 run 归一化百分比」数值表（不含顶部模型名行）。
 * 当前 run（序列 0）额外显示原始值，方便读数为绝对值。
 */
export function renderRadarAxisTable(axes: RadarAxis[], series: RadarSeries[]): string {
  const { norm } = radarNormalize(axes, series)
  // 先构造每格文本，再按列对齐，避免序列 0 带 (raw) 后缀时各行列错位
  const rows = axes.map((ax, i) => {
    const letter = String.fromCharCode(LETTER_BASE + i)
    const cells = series.map((s, si) => {
      const f = norm[si]![i]!
      const pct = `${Math.round(f * 100)}%`
      return si === 0 ? `${pct} (${ax.formatRaw(s.values[i] ?? 0)})` : pct
    })
    return { letter, label: ax.label, cells }
  })
  const colW = series.map((_, si) => Math.max(...rows.map(r => r.cells[si]!.length)))
  const lines = rows.map(r => {
    const label = r.label.padEnd(11)
    const cells = series
      .map((_, si) => r.cells[si]!.padStart(colW[si]!))
      .join('   ')
    return `  ${r.letter} ${label} ${cells}`
  })
  return lines.join('\n')
}

/**
 * 渲染图例（顶部模型名行 + 每轴数值表）。
 * 用于文本报告 / headless 展示；交互式 show 命令用彩色图例自行渲染模型名。
 */
export function renderRadarLegend(axes: RadarAxis[], series: RadarSeries[]): string {
  const names = series.map(
    (s, i) => `${PALETTE[i % PALETTE.length]} ${truncate(s.name, 20)}`,
  )
  return `  ${names.join('   ')}\n\n${renderRadarAxisTable(axes, series)}`
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

/** benchmark 历史根目录（每次 eval 落盘于此） */
export function benchmarksDir(): string {
  return resolve(process.cwd(), '.codev-benchmarks')
}

/**
 * 读取历史 run 目录下的 eval_results.json，构造可叠加的雷达序列。
 * - dataset：可选过滤（仅同 dataset）
 * - exclude：可选排除某个 run 目录（当前 run 自身）
 * - limit：可选截断（最近的优先）
 * 跳过缺 metrics 的旧 run（本次改动前未持久化 metrics 的历史）。
 */
async function readSavedRuns(
  base: string,
  opts: { dataset?: string; exclude?: string; limit?: number; dedupeByModel?: boolean } = {},
): Promise<RadarSeries[]> {
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return []
  }
  type RawRun = { model: string; startedAt: string; metrics: RunMetrics }
  const raw: RawRun[] = []
  for (const name of entries) {
    if (name === '' || (opts.exclude && name === opts.exclude)) continue
    try {
      const file = await readFile(join(base, name, 'eval_results.json'), 'utf8')
      const data = JSON.parse(file) as {
        dataset?: string
        model?: string
        startedAt?: string
        metrics?: RunMetrics
      }
      if (opts.dataset && data.dataset !== opts.dataset) continue
      if (!data.metrics) continue
      raw.push({
        model: data.model ?? '?',
        startedAt: data.startedAt ?? '',
        metrics: { ...data.metrics },
      })
    } catch {
      // 非 run 目录或不可读 → 跳过
    }
  }
  let series: RadarSeries[]
  if (opts.dedupeByModel) {
    // 每个模型仅保留最新一次 run（按 startedAt），profile 名即模型名 → 颜色按模型稳定
    const byModel = new Map<string, RawRun>()
    for (const r of raw) {
      const cur = byModel.get(r.model)
      if (!cur || r.startedAt > cur.startedAt) byModel.set(r.model, r)
    }
    series = [...byModel.values()].map(r => radarSeriesFromMetrics(r.metrics, r.model))
  } else {
    series = raw.map(r =>
      radarSeriesFromMetrics(r.metrics, shortRunName(r.model, r.startedAt)),
    )
  }
  // 模型名字典序稳定排序
  series.sort((a, b) => b.name.localeCompare(a.name))
  return opts.limit ? series.slice(0, opts.limit) : series
}

/**
 * 读取同一 dataset 下的历史 run，构造可叠加的对比序列（排除当前 run）。
 * 对应 Kiln compare 页「Compare Run Configurations」里选取多个 run config 叠加。
 */
export function loadComparisonSeries(
  run: BenchmarkRun,
  limit = 4,
): Promise<RadarSeries[]> {
  return readSavedRuns(dirname(run.runDir), {
    dataset: run.datasetName,
    exclude: basename(run.runDir),
    limit,
  })
}

/** 读取所有已保存的模型 profile（用于 /benchmark 直接展示雷达图） */
export function loadSavedProfiles(
  limit?: number,
  baseDir: string = benchmarksDir(),
): Promise<RadarSeries[]> {
  return readSavedRuns(baseDir, { limit, dedupeByModel: true })
}

/** 清空所有历史（/benchmark clear）。返回被移除的 run 目录数。 */
export async function clearHistory(baseDir: string = benchmarksDir()): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of entries) {
    if (name === '') continue
    try {
      await rm(join(baseDir, name), { recursive: true, force: true })
      removed++
    } catch {
      // 忽略单个删除失败
    }
  }
  return removed
}

function shortRunName(model: string, startedAt: string): string {
  const d = startedAt ? startedAt.slice(0, 10) : '?'
  const m = model.split('/').pop() ?? model
  return `${m} ${d}`
}
