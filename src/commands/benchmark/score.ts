/**
 * /benchmark —— ABSeeker 式步级打分（Clue-Anchored Step Scoring 简化版）。
 *
 * ABSeeker 的三步管线（recover clues → extract core anchors → score steps）在
 * benchmark 场景里简化成：direct lookup（不需要回溯）核心线索 = ground truth
 * 的各个组成要素。一步的动作若命中/逼近某个要素，就是 anchor / 正向；若把
 * 搜索引向无关方向，就是有害步。奖励失败轨迹中的有用动作，惩罚成功轨迹中
 * 的错误动作（ABSeeker 的核心动机）。
 */
import { truncate } from './estimate.js'
import { llmComplete } from './llm.js'
import type { StepScore, Trajectory } from './types.js'

const SCORE_SYSTEM_PROMPT = `You are a search-trajectory analyst. You are given a deep-research question, its ground-truth answer, and the agent's step-by-step trajectory (reasoning + tool action + result).

For EACH step, score how much it moved toward the ground-truth answer, using these labels:
- essential: directly obtains information in / critical for the ground truth (this is a "core clue anchor")
- useful: provides supporting or enabling information
- neutral: neither helped nor hurt much
- harmful: wasted effort, redundant, or actively misled the search

score ∈ [-1, 1]:
- +1.0..+0.6 essential anchor step
- +0.6..+0.2 useful
- +0.2..-0.2 neutral
- -0.2..-1.0 harmful

Reply with ONLY a single JSON object, no markdown:
{"steps":[{"step":1,"score":0.8,"is_anchor":true,"verdict":"essential","rationale":"short justification"}, ...]}`

/**
 * 给一条 trajectory 的每一步打分。失败返回 []。
 */
export async function scoreTrajectory(
  trajectory: Trajectory,
  opts: { model?: string; maxTokens?: number; maxRetries?: number } = {},
): Promise<StepScore[]> {
  const { model, maxTokens = 4096, maxRetries = 2 } = opts
  const stepsText = trajectory.steps
    .map(
      s =>
        `[step ${s.step}] action=${s.action} input=${truncate(s.actionInput, 120)}\n` +
        `reasoning: ${truncate(s.reasoning, 300)}\n` +
        `result: ${truncate(s.toolResult, 200)}`,
    )
    .join('\n\n')

  const userPrompt =
    `Research question:\n${trajectory.query}\n\n` +
    `Ground-truth answer:\n${trajectory.gt}\n\n` +
    `Trajectory:\n${truncate(stepsText, 12_000)}`

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await llmComplete(SCORE_SYSTEM_PROMPT, userPrompt, {
        ...(model ? { model } : {}),
        maxTokens,
      })
      const json = res.text.match(/\{[\s\S]*\}/)?.[0]
      if (!json) continue
      const parsed = JSON.parse(json) as {
        steps?: Array<Partial<StepScore> & { step: number }>
      }
      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) continue
      return parsed.steps
        .map(p => ({
          step: p.step,
          action:
            trajectory.steps.find(s => s.step === p.step)?.action ??
            ('error' as StepScore['action']),
          score: clampScore(p.score),
          isAnchor: p.isAnchor === true && (p.verdict ?? '') === 'essential',
          verdict: normalizeVerdict(p.verdict),
          rationale: truncate(p.rationale ?? '', 300),
        }))
        .filter(
          s =>
            s.step >= 1 && s.step <= Math.max(1, trajectory.steps.length),
        )
    } catch {
      if (attempt === maxRetries - 1) return []
    }
  }
  return []
}

const VERDICTS = ['essential', 'useful', 'neutral', 'harmful'] as const

function normalizeVerdict(
  v: unknown,
): 'essential' | 'useful' | 'neutral' | 'harmful' {
  return typeof v === 'string' &&
    (VERDICTS as readonly string[]).includes(v)
    ? (v as 'essential' | 'useful' | 'neutral' | 'harmful')
    : 'neutral'
}

function clampScore(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  return Math.max(-1, Math.min(1, v))
}