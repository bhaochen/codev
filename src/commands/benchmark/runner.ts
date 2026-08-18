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
import { buildInlineReport } from './report.js'
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
  /** agent（ReAct 搜索循环）模型 */
  model: string
  /** LLM-as-judge / 步级打分模型；留空则复用 model */
  judgeModel: string
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
    judgeModel: '',
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
      case '--judge-model': {
        const v = tokens[++i]
        if (v) args.judgeModel = v
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
      message: `model=${args.model}${args.judgeModel ? ` judge=${args.judgeModel}` : ''}, max-steps=${args.maxSteps}`,
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
      const judgeModel = args.judgeModel || args.model
      emit({ ...base, phase: 'evaluating', current: 0 })
      for (let i = 0; i < results.length; i++) {
        const t = results[i]!
        t.judged = await judgeTrajectory(t, { model: judgeModel })
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
      const judgeModel = args.judgeModel || args.model
      emit({ ...base, phase: 'scoring', current: 0 })
      for (let i = 0; i < results.length; i++) {
        const t = results[i]!
        t.stepScores = await scoreTrajectory(t, { model: judgeModel })
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
      judgeModel: args.judgeModel || args.model,
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

/** 最终文本报告（headless 模式输出 / UI 复用） */
export function buildReportText(run: BenchmarkRun): string {
  return buildInlineReport(run)
}