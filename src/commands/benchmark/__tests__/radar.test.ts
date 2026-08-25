import { describe, expect, test } from 'bun:test'
import {
  RADAR_AXES,
  radarNormalize,
  radarSeriesFromRun,
  renderRadar,
  renderRadarChart,
  renderRadarLegend,
} from '../radar.js'
import type { BenchmarkRun, Trajectory } from '../types.js'

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
  test('renders concentric grid + spokes + overlay for single run', () => {
    const chart = renderRadarChart(RADAR_AXES, [radarSeriesFromRun(mkRun())])
    expect(chart).toContain('A') // axis letters present
    expect(chart).toContain('.') // grid rings
    expect(chart).toContain('■') // series polygon marker
    expect(chart).toContain('+') // center
  })

  test('overlays multiple series with distinct markers', () => {
    const chart = renderRadarChart(RADAR_AXES, [
      radarSeriesFromRun(mkRun()),
      { name: 'other', values: [100, 10, 100, 1, 1000, 1000, 1] },
    ])
    expect(chart).toContain('■')
    expect(chart).toContain('□')
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
