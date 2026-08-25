import { describe, expect, test } from 'bun:test'
import {
  buildInlineReport,
  buildLiveProgressText,
  contextGrowthChart,
  metricsOf,
  questionTableLines,
  stepScoreLines,
  suggestionsLines,
} from '../report.js'
import type { Trajectory } from '../types.js'

function mkTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    id: 't1',
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
    llmTokensIn: 100,
    llmTokensOut: 50,
    llmDurationMs: 10,
    contextTokensBefore: (i + 1) * 500,
    contextTokensAfter: (i + 1) * 500 + 100,
  }))
}

describe('metricsOf', () => {
  test('aggregates accuracy, tokens, latency', () => {
    const run = {
      datasetName: 'd',
      model: 'm',
      maxSteps: 8,
      startedAt: '',
      durationMs: 2000,
      runDir: 'r',
      trajectories: [
        mkTrajectory({
          id: 'a',
          steps: mkSteps(2),
          judged: { correct: true, score: 8, rationale: '' },
          naturallyAnswered: true,
          durationMs: 1000,
        }),
        mkTrajectory({
          id: 'b',
          steps: mkSteps(3),
          judged: { correct: false, score: 2, rationale: '' },
          naturallyAnswered: false,
          durationMs: 3000,
        }),
      ],
    }
    const m = metricsOf(run)
    expect(m.total).toBe(2)
    expect(m.correct).toBe(1)
    expect(m.accuracyPct).toBe(50)
    expect(m.avgScore).toBeCloseTo(5)
    expect(m.avgSteps).toBeCloseTo(2.5)
    expect(m.avgTokensIn).toBe(250) // (2+3) * 100 / 2
    expect(m.avgTokensOut).toBe(125)
    expect(m.avgTimeSec).toBeCloseTo(2)
    expect(m.honestAnswers).toBe(50)
  })
})

describe('questionTableLines', () => {
  test('marks correct/incorrect with ✔/✘', () => {
    const run = {
      datasetName: 'd',
      model: 'm',
      maxSteps: 8,
      startedAt: '',
      durationMs: 0,
      runDir: 'r',
      trajectories: [
        mkTrajectory({
          id: 'ok',
          steps: mkSteps(1),
          judged: { correct: true, score: 9.5, rationale: '' },
        }),
        mkTrajectory({
          id: 'bad',
          steps: mkSteps(1),
          judged: { correct: false, score: 1.5, rationale: '' },
        }),
      ],
    }
    const lines = questionTableLines(run)
    expect(lines[0]).toContain('ID')
    expect(lines.some(l => l.includes('✔') && l.includes('ok'))).toBe(true)
    expect(lines.some(l => l.includes('✘') && l.includes('bad'))).toBe(true)
  })
})

describe('contextGrowthChart', () => {
  test('single trajectory: no avg series', () => {
    const chart = contextGrowthChart([
      mkTrajectory({ id: 'only', steps: mkSteps(2) }),
    ])
    expect(chart).toContain('┼')
    expect(chart).not.toContain('avg')
    expect(chart).toContain('· only')
  })

  test('two trajectories: avg line + legend', () => {
    const chart = contextGrowthChart([
      mkTrajectory({ id: 'one', steps: mkSteps(2) }),
      mkTrajectory({ id: 'two', steps: mkSteps(3) }),
    ])
    expect(chart).toContain('· avg')
    expect(chart).toContain('· one')
    expect(chart).toContain('· two')
  })
})

describe('stepScoreLines', () => {
  test('renders per-step score with anchor mark', () => {
    const lines = stepScoreLines({
      datasetName: 'd',
      model: 'm',
      maxSteps: 3,
      startedAt: '',
      durationMs: 0,
      runDir: 'r',
      trajectories: [
        mkTrajectory({
          id: 't',
          steps: mkSteps(2),
          stepScores: [
            {
              step: 1,
              action: 'search_web',
              score: 0.9,
              isAnchor: true,
              verdict: 'essential',
              rationale: '',
            },
            {
              step: 2,
              action: 'answer',
              score: -0.5,
              isAnchor: false,
              verdict: 'harmful',
              rationale: '',
            },
          ],
        }),
      ],
    })
    expect(lines.join('\n')).toContain('1:search_web +0.9◆')
    expect(lines.join('\n')).toContain('2:answer -0.5✗')
  })

  test('no scores → n/a placeholder', () => {
    const lines = stepScoreLines({
      datasetName: 'd',
      model: 'm',
      maxSteps: 3,
      startedAt: '',
      durationMs: 0,
      runDir: 'r',
      trajectories: [mkTrajectory()],
    })
    expect(lines.join('\n')).toContain('n/a')
  })
})

describe('suggestionsLines', () => {
  test('stays small → none', () => {
    const lines = suggestionsLines({
      datasetName: 'd',
      model: 'm',
      maxSteps: 3,
      startedAt: '',
      durationMs: 0,
      runDir: 'r',
      trajectories: [mkTrajectory({ steps: mkSteps(2) })],
    })
    expect(lines.join('\n')).toContain('none')
  })
})

describe('buildLiveProgressText', () => {
  test('loading phase shows message', () => {
    const text = buildLiveProgressText({
      phase: 'loading',
      datasetName: 'deepsearch-demo',
      total: 0,
      current: 0,
      currentId: '',
      currentQuery: '',
      currentSteps: 0,
      currentCtxTokens: 0,
      currentAction: '',
      message: 'model=m',
    })
    expect(text).toContain('benchmark')
    expect(text).toContain('model=m')
  })

  test('running phase shows progress line', () => {
    const text = buildLiveProgressText({
      phase: 'running',
      datasetName: 'd',
      total: 4,
      current: 2,
      currentId: 'demo-2',
      currentQuery: 'q',
      currentSteps: 3,
      currentCtxTokens: 6200,
      currentAction: 'search_web',
    })
    expect(text).toContain('(2/4)')
    expect(text).toContain('demo-2')
    expect(text).toContain('step 3')
    expect(text).toContain('searching')
    expect(text).toContain('6.2k tok')
  })
})

describe('buildInlineReport', () => {
  test('contains metrics, table, chart and suggestions sections', () => {
    const report = buildInlineReport({
      datasetName: 'd',
      model: 'm',
      judgeModel: 'j',
      maxSteps: 4,
      startedAt: '',
      durationMs: 0,
      runDir: 'x',
      trajectories: [
        mkTrajectory({
          id: 't',
          steps: mkSteps(2),
          judged: { correct: true, score: 8, rationale: '' },
        }),
      ],
    })
    expect(report).toContain('deepsearch benchmark report')
    expect(report).toContain('judge: j')
    expect(report).toContain('▍metrics')
    expect(report).toContain('▍per-question')
    expect(report).toContain('▍context growth per step')
    expect(report).toContain('▍context meta-op suggestions')
    expect(report).toContain('▍radar')
  })

  test('includes radar section with compare series overlaid', () => {
    const report = buildInlineReport(
      {
        datasetName: 'd',
        model: 'm',
        judgeModel: 'j',
        maxSteps: 4,
        startedAt: '',
        durationMs: 0,
        runDir: 'x',
        trajectories: [
          mkTrajectory({
            id: 't',
            steps: mkSteps(2),
            judged: { correct: true, score: 8, rationale: '' },
          }),
        ],
      },
      {
        compare: [
          { name: 'prev', values: [80, 6, 90, 5, 8000, 22000, 5] },
        ],
      },
    )
    expect(report).toContain('▍radar')
    expect(report).toContain('prev')
    expect(report).toContain('Accuracy')
  })
})