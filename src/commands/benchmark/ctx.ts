/**
 * /benchmark —— LongSeeker 式长程 Research Context 统计。
 *
 * 判断什么时候该对 trajectory 的 step block 做元操作：
 * Compress（合并一段进入 context 代价高、信息量低的步骤）、Delete（有害步）、
 * Rollback（从某步起整体回退——当模型自己转了方向）、Snippet（只保留某步
 * 关键片段）。输出建议，供 UI 展示与复盘。
 */
import {
  WORKING_CONTEXT_TARGET,
  type ContextAnalysis,
  type ContextSuggestion,
  type Trajectory,
} from './types.js'

/**
 * 基于 trajectory 递增 context 曲线（steps[].contextTokensBefore/After）产出建议。
 * 打分来源：trajectory.stepScores（ABSeeker 步级打分跑完后由 runner 写回）。
 */
export function analyzeContextFromSteps(trajectory: Trajectory): ContextAnalysis {
  const steps = trajectory.steps
  const scores = trajectory.stepScores

  let peakTokens = 0
  let thresholdExceededAtStep = 0
  const totalBeforeTokens = steps.map(s => s.contextTokensBefore)
  const afterTokens = steps.map(s => s.contextTokensAfter)

  for (let i = 0; i < steps.length; i++) {
    const after = afterTokens[i] ?? 0
    if (after > peakTokens) peakTokens = after
    if (after > WORKING_CONTEXT_TARGET && thresholdExceededAtStep === 0) {
      thresholdExceededAtStep = steps[i]!.step
    }
  }

  const finalTokens = afterTokens.at(-1) ?? peakTokens
  const suggestions: ContextSuggestion[] = []

  // 1) harmful 步 → delete
  for (const s of scores) {
    if (s.verdict === 'harmful') {
      suggestions.push({
        kind: 'delete',
        step: s.step,
        contextTokens: afterTokens[s.step - 1] ?? 0,
        reason: `harmful step (score ${s.score.toFixed(2)}): ${truncate(s.rationale, 90)}`,
      })
    }
  }

  // 2) 低分 + 高 context 代价 → compress
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    const score = scores.find(s => s.step === step.step)
    const stepCost = (afterTokens[i] ?? 0) - (totalBeforeTokens[i] ?? 0)
    const lowValue = score === undefined || score.score <= 0.2
    if (lowValue && stepCost > 800 && step.action !== 'answer') {
      suggestions.push({
        kind: 'compress',
        step: step.step,
        contextTokens: stepCost,
        reason: `low-value step cost +${stepCost.toLocaleString()} ctx tokens (score ${score?.score.toFixed(2) ?? 'n/a'})`,
      })
    }
  }

  // 3) 超过 working target → 从超过点开始建议压缩
  if (thresholdExceededAtStep > 0) {
    const tail = steps.filter(s => s.step >= thresholdExceededAtStep)
    if (tail.length >= 2) {
      suggestions.push({
        kind: 'compress',
        step: thresholdExceededAtStep,
        contextTokens: peakTokens,
        reason: `context exceeded ${WORKING_CONTEXT_TARGET.toLocaleString()} tokens at step ${thresholdExceededAtStep} — merge steps ${thresholdExceededAtStep}–${steps.at(-1)?.step} into one summary block`,
      })
    }
  }

  // 4) 搜索主线索方向突变 → rollback 候选
  const firstAnswerIdx = steps.findIndex(s => s.action === 'answer')
  const meaningful = firstAnswerIdx === -1 ? steps : steps.slice(0, firstAnswerIdx)
  for (let i = 2; i < meaningful.length; i++) {
    const prev = meaningful[i - 1]
    const cur = meaningful[i]
    if (
      prev &&
      cur &&
      isSearch(prev.action) &&
      isSearch(cur.action) &&
      directionChange(prev.actionInput, cur.actionInput)
    ) {
      suggestions.push({
        kind: 'rollback',
        step: prev.step,
        contextTokens: afterTokens[cur.step - 1] ?? 0,
        reason: `search shifted from "${truncate(prev.actionInput, 60)}" to "${truncate(cur.actionInput, 60)}" at step ${cur.step}; rollback would drop this detour`,
      })
      break
    }
  }

  // 5) 抓取的长页面 → snippet
  for (const step of steps) {
    const cost = step.contextTokensAfter - step.contextTokensBefore
    if (step.action === 'visit_web' && cost > 2000) {
      suggestions.push({
        kind: 'snippet',
        step: step.step,
        contextTokens: cost,
        reason: `visited page added ~${cost.toLocaleString()} ctx tokens — keep only the snippet containing the core fact`,
      })
    }
  }

  return {
    peakTokens,
    finalTokens,
    thresholdExceededAtStep,
    suggestions,
  }
}

function isSearch(a: string): boolean {
  return a === 'search_web' || a === 'visit_web'
}

/** 两个 search query 是否明显改向（无公共关键 n-gram） */
function directionChange(a: string, b: string): boolean {
  const grams = (s: string) => {
    const words = s
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3)
    const out: string[] = []
    for (let i = 0; i + 1 < words.length; i++) {
      out.push(`${words[i]} ${words[i + 1]}`.slice(0, 40))
    }
    return new Set(out)
  }
  const ga = grams(a)
  const gb = grams(b)
  if (gb.size === 0) return false
  let overlap = 0
  for (const g of gb) if (ga.has(g)) overlap++
  return overlap === 0
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}