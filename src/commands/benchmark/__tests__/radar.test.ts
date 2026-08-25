import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RADAR_AXES,
  clearHistory,
  loadSavedProfiles,
  radarNormalize,
  radarOverall,
  radarSeriesFromRun,
  radarTableRows,
  renderRadar,
  renderRadarAxisTable,
  renderRadarChart,
  renderRadarLegend,
} from '../radar.js'
import type { BenchmarkRun, Trajectory } from '../types.js'
import type { RunMetrics } from '../report.js'

function mkTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    id: 't',
    query: 'q',
    gt: 'g',
    model: 'm',
    answer: 'a',
    steps: [],
    stepScores: [],
    judged: null,
    startedAt: '',
    durationMs: 1000,
    naturallyAnswered: false,
    ...overrides,
  }
}

function mkSteps(n: number): Trajectory['steps'] {
  return Array.from({ length: n }, (_, i) => ({
    step: i + 1,
    reasoning: 'r',
    action: 'search_web' as const,
    actionInput: 'x',
    toolResult: 'y',
    llmTokensIn: 1000,
    llmTokensOut: 500,
    llmDurationMs: 1000,
    contextTokensBefore: (i + 1) * 2000,
    contextTokensAfter: (i + 1) * 2000 + 500,
  }))
}

function mkRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    datasetName: 'deepsearch-demo',
    model: 'deepseek-v4-flash-free',
    judgeModel: 'deepseek-v4-flash-free',
    maxSteps: 8,
    startedAt: '2026-08-25T00:00:00.000Z',
    durationMs: 4000,
    runDir: '/tmp/.codev-benchmarks/run-x',
    trajectories: [
      mkTrajectory({
        id: 'a',
        steps: mkSteps(2),
        judged: { correct: true, score: 8, rationale: '' },
        naturallyAnswered: true,
        durationMs: 2000,
      }),
      mkTrajectory({
        id: 'b',
        steps: mkSteps(3),
        judged: { correct: false, score: 2, rationale: '' },
        naturallyAnswered: false,
        durationMs: 2000,
      }),
    ],
    ...overrides,
  }
}

describe('radarSeriesFromRun', () => {
  test('produces 7 values aligned to RADAR_AXES', () => {
    const s = radarSeriesFromRun(mkRun())
    expect(s.values.length).toBe(RADAR_AXES.length)
    expect(RADAR_AXES.length).toBeGreaterThanOrEqual(3)
    // accuracy 50%, avg score 5.0
    expect(s.values[0]).toBeCloseTo(50)
    expect(s.values[1]).toBeCloseTo(5)
  })
})

describe('radarNormalize', () => {
  test('higher-is-better: larger raw → larger norm', () => {
    const series = [
      { name: 'low', values: [0, 0, 0, 16, 40000, 120000, 60] },
      { name: 'high', values: [100, 10, 100, 1, 1000, 1000, 1] },
    ]
    const { norm } = radarNormalize(RADAR_AXES, series)
    // accuracy (idx0, higher better): low=0, high=1
    expect(norm[0]![0]).toBeCloseTo(0)
    expect(norm[1]![0]).toBeCloseTo(1)
  })

  test('lower-is-better inverted: smaller raw → larger norm', () => {
    const series = [
      { name: 'slow', values: [0, 0, 0, 16, 40000, 120000, 60] },
      { name: 'fast', values: [0, 0, 0, 2, 2000, 6000, 3] },
    ]
    const { norm } = radarNormalize(RADAR_AXES, series)
    // speed idx6 lowerIsBetter: slow(60)→0, fast(3)→ ~0.95
    expect(norm[0]![6]).toBeCloseTo(0)
    expect(norm[1]![6]).toBeGreaterThan(norm[0]![6]!)
  })

  test('clamps to [0,1] and respects reference max', () => {
    const series = [{ name: 'a', values: [200, 20, 200, 100, 9e9, 9e9, 999] }]
    const { norm } = radarNormalize(RADAR_AXES, series)
    for (const v of norm[0]!) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('renderRadarChart', () => {
  test('renders braille grid + spokes + overlay for single run', () => {
    const chart = renderRadarChart(RADAR_AXES, [radarSeriesFromRun(mkRun())])
    expect(chart).toContain('A') // axis letters present
    expect(chart).toContain('+') // center
    expect(chart).toMatch(/[\u2800-\u28FF]/) // braille dots drawn
  })

  test('overlays multiple series with distinct colors', () => {
    const colored = renderRadarChart(
      RADAR_AXES,
      [
        { name: 'm-a', values: [100, 10, 100, 1, 1000, 1000, 1] },
        { name: 'm-b', values: [80, 6, 90, 5, 8000, 20000, 5] },
      ],
      { colorize: true },
    )
    expect(colored).toMatch(/[⠀-⣿]/)
    const codes = new Set(
      [...colored.matchAll(/\x1b\[(\d+)m/g)].map(m => m[1]!),
    )
    expect(codes.size).toBeGreaterThanOrEqual(2)
  })

  test('rejects <3 axes', () => {
    expect(renderRadarChart(RADAR_AXES.slice(0, 2), [])).toContain('≥3 axes')
  })
})

describe('renderRadarLegend', () => {
  test('lists axes with percentages and raw for current run', () => {
    const legend = renderRadarLegend(RADAR_AXES, [radarSeriesFromRun(mkRun())])
    expect(legend).toContain('Accuracy')
    expect(legend).toContain('%')
  })
})

describe('radar metric rows / overall / table', () => {
  test('radarTableRows produces A–G 3-col rows, raw as X/100 for accuracy', () => {
    const rows = radarTableRows(RADAR_AXES, [radarSeriesFromRun(mkRun())])
    expect(rows.length).toBe(7)
    expect(rows[0]!.letter).toBe('A')
    expect(rows[0]!.label).toBe('Accuracy')
    // 新格式：Score 为百分比，Raw 为 50/100（不再内联 ` (50%)`）
    expect(rows[0]!.score).toMatch(/^\d+%$/)
    expect(rows[0]!.raw).toBe('50/100')
  })

  test('renderRadarAxisTable right-aligns and drops inline parens', () => {
    const t = renderRadarAxisTable(RADAR_AXES, [radarSeriesFromRun(mkRun())])
    expect(t).not.toContain('(')
    expect(t).toContain('50/100')
    // 数字列右对齐：第二行的百分比起点应与其上、下行对齐
    const lines = t.split('\n')
    const scoreCol = (l: string) => l.replace(/^ [A-G]  /, '').split(/\s+/)[1] ?? ''
    expect(scoreCol(lines[0]!)).toMatch(/^\d+%$/)
  })

  test('radarOverall is mean of axis percentages within (0,100]', () => {
    const o = radarOverall(RADAR_AXES, [radarSeriesFromRun(mkRun())])
    expect(o).toBeGreaterThan(0)
    expect(o).toBeLessThanOrEqual(100)
  })
})

describe('renderRadar', () => {
  test('combines chart + legend with compare series', () => {
    const out = renderRadar(RADAR_AXES, [
      radarSeriesFromRun(mkRun()),
      { name: 'prev', values: [80, 6, 90, 5, 8000, 20000, 5] },
    ])
    expect(out).toContain('■')
    expect(out).toContain('□')
    expect(out).toContain('Accuracy')
  })
})

describe('renderRadarChart colorize', () => {
  test('emits ANSI escapes only when colorize=true', () => {
    const colored = renderRadarChart(RADAR_AXES, [radarSeriesFromRun(mkRun())], {
      colorize: true,
    })
    expect(colored).toContain('\x1b[')
    const plain = renderRadarChart(RADAR_AXES, [radarSeriesFromRun(mkRun())])
    expect(plain).not.toContain('\x1b[')
  })

  test('distinct models get distinct colors (matches legend order)', () => {
    const series = [
      { name: 'model-a', values: [100, 10, 100, 1, 1000, 1000, 1] },
      { name: 'model-b', values: [80, 6, 90, 5, 8000, 20000, 5] },
      { name: 'model-c', values: [60, 4, 70, 8, 16000, 40000, 9] },
    ]
    const colored = renderRadarChart(RADAR_AXES, series, { colorize: true })
    // 3 个模型 → 3 种 ANSI 颜色码；图与图例按同一 series 顺序取色，必然互异
    const codes = new Set(
      [...colored.matchAll(/\x1b\[(\d+)m/g)].map(m => m[1]!),
    )
    expect(codes.size).toBeGreaterThanOrEqual(3)
  })
})

describe('loadSavedProfiles / clearHistory', () => {
  function mkMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
    return {
      correct: 1,
      total: 2,
      accuracyPct: 50,
      avgScore: 5,
      avgSteps: 2.5,
      avgCtxTokens: 5000,
      avgTokensIn: 250,
      avgTokensOut: 125,
      avgTimeSec: 2,
      peakCtxTokens: 6000,
      honestAnswers: 50,
      ...overrides,
    }
  }

  async function writeRun(
    base: string,
    dir: string,
    model: string,
    startedAt: string,
    m: RunMetrics,
  ): Promise<void> {
    await mkdir(join(base, dir), { recursive: true })
    await writeFile(
      join(base, dir, 'eval_results.json'),
      JSON.stringify({ dataset: 'deepsearch-demo', model, startedAt, metrics: m }),
      'utf8',
    )
  }

  test('dedupes by model and names profile by model (latest kept)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codev-bench-'))
    try {
      await writeRun(base, 'run-1', 'model-a', '2026-01-01T00:00:00Z', mkMetrics({ accuracyPct: 80 }))
      await writeRun(base, 'run-2', 'model-a', '2026-02-01T00:00:00Z', mkMetrics({ accuracyPct: 90 }))
      await writeRun(base, 'run-3', 'model-b', '2026-01-01T00:00:00Z', mkMetrics({ accuracyPct: 70 }))
      const profiles = await loadSavedProfiles(undefined, base)
      expect(profiles.length).toBe(2) // model-a + model-b
      const a = profiles.find(p => p.name === 'model-a')!
      expect(a).toBeDefined()
      // 同名模型只保留最新一次 run（accuracy 90）
      expect(a.values[0]).toBeCloseTo(90)
      expect(profiles.some(p => p.name === 'model-b')).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('clearHistory removes all saved run dirs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codev-bench-'))
    try {
      await writeRun(base, 'run-1', 'model-a', '2026-01-01T00:00:00Z', mkMetrics())
      const removed = await clearHistory(base)
      expect(removed).toBe(1)
      expect((await loadSavedProfiles(undefined, base)).length).toBe(0)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
