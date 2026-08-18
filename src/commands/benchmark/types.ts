/**
 * /benchmark —— deepsearch benchmark 共享类型。
 *
 * 参考：
 * - OpenSeeker 的 trajectory 保存（result_{id}.json）与 {id, query, gt} 数据集格式
 * - ABSeeker 的步级打分（Clue-Anchored Step Scoring）
 * - LongSeeker 的 context 元操作（Skip/Compress/Rollback/Snippet/Delete）
 */

/** 数据集条目：{id, query, gt}（兼容 ABSeeker/XBench 的 gold/answer 字段） */
export type BenchmarkItem = {
  id: string
  query: string
  gt: string
}

export type AgentAction = 'search_web' | 'visit_web' | 'answer' | 'error'

/** ReAct 循环中的一步 */
export type BenchmarkStep = {
  step: number
  reasoning: string
  action: AgentAction
  actionInput: string
  toolResult: string
  /** 调用 LLM 后实测 usage */
  llmTokensIn: number
  llmTokensOut: number
  llmDurationMs: number
  /** 本次调用前 transcript 的估算 token 数（LongSeeker context 统计） */
  contextTokensBefore: number
  /** 追加 toolResult 后的估算 token 数 */
  contextTokensAfter: number
}

export type StepVerdict = 'essential' | 'useful' | 'neutral' | 'harmful'

/** ABSeeker 式步级打分 */
export type StepScore = {
  step: number
  action: AgentAction
  score: number // -1（有害/偏离）.. +1（关键）
  isAnchor: boolean // 是否命中核心线索（clue anchor）
  verdict: StepVerdict
  rationale: string
}

/** LLM-as-judge 评测结果（OpenSeeker eval.py 语义） */
export type JudgeResult = {
  correct: boolean
  score: number // 0-10
  rationale: string
}

/** 单条 query 的完整 trajectory */
export type Trajectory = {
  id: string
  query: string
  gt: string
  model: string
  answer: string
  steps: BenchmarkStep[]
  stepScores: StepScore[]
  judged: JudgeResult | null
  startedAt: string
  durationMs: number
  /** 是否在 maxSteps 内自然产出 <answer>（而非被强制收尾） */
  naturallyAnswered: boolean
  error?: string
}

/** LongSeeker 式 context 分析 */
export type ContextSuggestion = {
  kind: 'compress' | 'delete' | 'rollback' | 'snippet'
  step: number
  contextTokens: number
  reason: string
}

export type ContextAnalysis = {
  peakTokens: number
  finalTokens: number
  /** 超过 LongSeeker working-context 目标的第一步（0 表示从未超过） */
  thresholdExceededAtStep: number
  suggestions: ContextSuggestion[]
}

/** 一次 benchmark 运行的整体结果 */
export type BenchmarkRun = {
  datasetName: string
  model: string
  /** LLM-as-judge / 步级打分模型（复用 agent 模型时与 model 相同） */
  judgeModel?: string
  maxSteps: number
  startedAt: string
  durationMs: number
  trajectories: Trajectory[]
  runDir: string
}

export const WORKING_CONTEXT_TARGET = 15_000