/**
 * /benchmark —— 核心编排。
 *
 * 流程（被本地 JSX UI 与 headless 本地命令共用）：
 *  1. 解析参数、加载数据集
 *  2. 逐条 query 跑 ReAct agent（OpenSeeker tool loop），保存 trajectory
 *  3. LLM-as-judge 评测（OpenSeeker eval.py）
 *  4. ABSeeker 式步级打分
 *  5. LongSeeker 式 context 统计
 *  6. 汇总写盘 + 文本报告
 */
import { mkdir, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { runAgent } from './agent.js'
import { analyzeContextFromSteps } from './ctx.js'
import { loadDataset } from './datasets.js'
import { judgeTrajectory } from './judge.js'
import { scoreTrajectory } from './score.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import type {
  BenchmarkRun,
  ContextAnalysis,
  Trajectory,
} from './types.js'

/** /benchmark 命令行参数 */
export type BenchmarkArgs = {
  dataset: string
  model: string
  maxSteps: number
  limit: number
  out: string
  judge: boolean
  score: boolean
}

export type BenchmarkPhase =
  | 'loading'
  | 'running'
  | 'evaluating'
  | 'scoring'
  | 'analyzing'
  | 'done'
  | 'error'

export type BenchmarkProgress = {
  phase: BenchmarkPhase
  datasetName: string
  total: number
  /** 1-based，当前条目序号 */
  current: number
  currentId: string
  currentQuery: string
  currentSteps: number
  currentCtxTokens: number
  currentAction: string
  /** 已完成条目的快照 */
  trajectories: Trajectory[]
  message?: string
}

export function parseBenchmarkArgs(raw: string): BenchmarkArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const args: BenchmarkArgs = {
    dataset: 'deepsearch-demo',
    model: getMainLoopModel(),
    maxSteps: 8,
    limit: Infinity,
    out: '',
    judge: true,
    score: true,
  }
  const positional: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    switch (t) {
      case '--max-steps': {
        const v = Number(tokens[++i])
        if (!Number.isNaN(v) && v > 0) args.maxSteps = v
        break
      }
      case '--limit': {
        const v = Number(tokens[++i])
        if (!Number.isNaN(v) && v > 0) args.limit = v
        break
      }
      case '--model': {
        const v = tokens[++i]
        if (v) args.model = v
        break
      }
      case '--out': {
        const v = tokens[++i]
        if (v) args.out = v
        break
      }
      case '--no-judge':
        args.judge = false
        break
      case '--no-score':
        args.score = false
        break
      default:
        if (!t.startsWith('--')) positional.push(t)
    }
  }
  if (positional.length > 0) args.dataset = positional[0]!
  return args
}

export type RunBenchmarkOptions = {
  args: BenchmarkArgs
  onProgress?: (p: BenchmarkProgress) => void
}

/**
 * 跑完整 benchmark。失败时 phase 切到 error 再 rethrow。
 */
export async function runBenchmark(
  opts: RunBenchmarkOptions,
): Promise<BenchmarkRun> {
  const { args, onProgress } = opts
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const results: Trajectory[] = []

  const emit = (partial: Partial<BenchmarkProgress> & { phase: BenchmarkPhase }) =>
    onProgress?.({
      datasetName: '',
      total: 0,
      current: 0,
      currentId: '',
      currentQuery: '',
      currentSteps: 0,
      currentCtxTokens: 0,
      currentAction: '',
      ...partial,
      trajectories: [...results],
    })

  try {
    const { name, items } = await loadDataset(args.dataset)
    const datasetName = name.startsWith(process.cwd())
      ? name.slice(process.cwd().length + 1)
      : name

    const runDir = resolve(
      process.cwd(),
      args.out ||
        join(
          '.codev-benchmarks',
          `${(datasetName.split('/').at(-1) ?? datasetName).replace(/\.[^.]+$/, '')}-${runId}`,
        ),
    )
    await mkdir(runDir, { recursive: true })

    const limited =
      args.limit === Infinity ? items : items.slice(0, args.limit)
    const base = {
      datasetName,
      total: limited.length,
    }
    emit({
      ...base,
      phase: 'loading',
      message: `model=${args.model}, max-steps=${args.maxSteps}`,
    })

    // ---- Phase 1: 跑 agent（OpenSeeker 的 ReAct tool loop）----
    emit({ ...base, phase: 'running', current: 0 })
    for (let idx = 0; idx < limited.length; idx++) {
      const item = limited[idx]!
      const trajectory = await runAgent(item, {
        model: args.model,
        maxSteps: args.maxSteps,
        maxTranscriptTokens: 60_000,
        onStep: t => {
          const last = t.steps.at(-1)
          emit({
            ...base,
            phase: 'running',
            current: idx + 1,
            currentId: item.id,
            currentQuery: item.query,
            currentSteps: t.steps.length,
            currentCtxTokens: last?.contextTokensAfter ?? 0,
            currentAction: last?.action ?? '',
          })
        },
      })
      // 单条 trajectory 立即落盘（OpenSeeker 的 result_{id}.json）
      await writeTrajectory(runDir, trajectory)
      results.push(trajectory)
    }

    // ---- Phase 2: LLM-as-judge 评测（OpenSeeker eval.py）----
    if (args.judge) {
      emit({ ...base, phase: 'evaluating', current: 0 })
      for (let i = 0; i < results.length; i++) {
        const t = results[i]!
        t.judged = await judgeTrajectory(t, { model: args.model })
        await writeTrajectory(runDir, t)
        emit({
          ...base,
          phase: 'evaluating',
          current: i + 1,
          currentId: t.id,
          currentSteps: t.steps.length,
          currentCtxTokens: t.steps.at(-1)?.contextTokensAfter ?? 0,
          currentAction: 'judge',
        })
      }
    }

    // ---- Phase 3: ABSeeker 式步级打分 ----
    if (args.score) {
      emit({ ...base, phase: 'scoring', current: 0 })
      for (let i = 0; i < results.length; i++) {
        const t = results[i]!
        t.stepScores = await scoreTrajectory(t, { model: args.model })
        await writeTrajectory(runDir, t)
        emit({
          ...base,
          phase: 'scoring',
          current: i + 1,
          currentId: t.id,
          currentSteps: t.steps.length,
          currentCtxTokens: t.steps.at(-1)?.contextTokensAfter ?? 0,
          currentAction: 'score',
        })
      }
    }

    // ---- Phase 4: LongSeeker 式 context 统计 ----
    emit({ ...base, phase: 'analyzing', current: 0 })
    for (const t of results) {
      const analysis = analyzeContextFromSteps(t)
      await writeAnalysis(runDir, t, analysis).catch(() => undefined)
    }

    // ---- 汇总写盘 ----
    const run: BenchmarkRun = {
      datasetName,
      model: args.model,
      maxSteps: args.maxSteps,
      startedAt,
      durationMs: Date.now() - startedMs,
      trajectories: results,
      runDir,
    }
    await writeFile(
      join(runDir, 'eval_results.json'),
      JSON.stringify(
        {
          dataset: datasetName,
          model: run.model,
          startedAt,
          durationMs: run.durationMs,
          trajectories: results.map(summarizeTrajectory),
        },
        null,
        2,
      ),
      'utf8',
    )
    emit({ ...base, phase: 'done', current: results.length })
    return run
  } catch (err) {
    emit({
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

function sanitize(id: string): string {
  return id.replace(/[^\w.-]/g, '_')
}

async function writeTrajectory(runDir: string, t: Trajectory) {
  await writeFile(
    join(runDir, `result_${sanitize(t.id)}.json`),
    JSON.stringify(t, null, 2),
    'utf8',
  )
}

/** LongSeeker context 分析落盘（复盘：什么时候该压缩/删除/回退） */
async function writeAnalysis(
  runDir: string,
  t: Trajectory,
  analysis: ContextAnalysis,
) {
  await writeFile(
    join(runDir, `context_${sanitize(t.id)}.json`),
    JSON.stringify(analysis, null, 2),
    'utf8',
  )
}

function summarizeTrajectory(t: Trajectory) {
  return {
    id: t.id,
    query: t.query,
    answer: t.answer,
    correct: t.judged?.correct,
    score: t.judged?.score,
    rationale: t.judged?.rationale,
    steps: t.steps.length,
    contextTokens: t.steps.at(-1)?.contextTokensAfter ?? 0,
  }
}

export type RunSummary = {
  correct: number
  total: number
  sumScore: number
  avgSteps: number
  avgCtxTokens: number
  avgTimeMs: number
}

export function summarizeRun(run: BenchmarkRun): RunSummary {
  const judged = run.trajectories.filter(t => t.judged !== null)
  const correct = judged.filter(t => t.judged?.correct).length
  const sumScore = judged.reduce((a, t) => a + (t.judged?.score ?? 0), 0)
  const n = Math.max(1, run.trajectories.length)
  const avgSteps = run.trajectories.reduce((a, t) => a + Math.max(1, t.steps.length), 0) / n
  const avgCtxTokens =
    run.trajectories.reduce((a, t) => a + (t.steps.at(-1)?.contextTokensAfter ?? 0), 0) / n
  const avgTimeMs = run.trajectories.reduce((a, t) => a + t.durationMs, 0) / n
  return { correct, total: run.trajectories.length, sumScore, avgSteps, avgCtxTokens, avgTimeMs }
}

/** 最终文本报告（headless 模式输出 / UI onDone 摘要复用） */
export function buildReportText(run: BenchmarkRun): string {
  const s = summarizeRun(run)
  const lines: string[] = []
  lines.push(`Benchmark report — ${run.datasetName}`)
  lines.push(`model: ${run.model}   max-steps: ${run.maxSteps}`)
  lines.push(
    `accuracy: ${s.correct}/${s.total} (${((s.correct / Math.max(1, s.total)) * 100).toFixed(1)}%)   avg score: ${(s.sumScore / Math.max(1, s.total)).toFixed(2)}`,
  )
  lines.push(
    `avg steps: ${s.avgSteps.toFixed(1)}   avg ctx: ${Math.round(s.avgCtxTokens).toLocaleString()} tok   avg time: ${(s.avgTimeMs / 1000).toFixed(1)}s`,
  )
  lines.push('')
  lines.push(
    `${'ID'.padEnd(22)} corr  score  steps  ctx(tok)  question`,
  )
  for (const t of run.trajectories) {
    const mark = t.judged === null ? '·' : t.judged.correct ? '✔' : '✘'
    const score = t.judged === null ? '—' : t.judged.score.toFixed(1)
    const ctx = (t.steps.at(-1)?.contextTokensAfter ?? 0).toLocaleString()
    lines.push(
      `${t.id.padEnd(22)} ${mark.padEnd(4)} ${score.padStart(5)} ${String(t.steps.length).padStart(5)} ${ctx.padStart(9)}  ${truncateQuery(t.query)}`,
    )
    if (t.error) lines.push(`      note: ${t.error}`)
  }
  lines.push('')
  lines.push('LongSeeker context suggestions:')
  const anySuggestion = run.trajectories.some(
    t => analyzeContextFromSteps(t).suggestions.length > 0,
  )
  if (!anySuggestion) {
    lines.push('  none')
  } else {
    for (const t of run.trajectories) {
      for (const sug of analyzeContextFromSteps(t).suggestions) {
        lines.push(
          `  ${t.id} · ${sug.kind} @step ${sug.step} (${sug.contextTokens.toLocaleString()} tok): ${sug.reason}`,
        )
      }
    }
  }
  lines.push('')
  lines.push(`trajectories saved to: ${run.runDir}`)
  return lines.join('\n')
}

function truncateQuery(q: string): string {
  return q.length > 60 ? `${q.slice(0, 58)}…` : q
}