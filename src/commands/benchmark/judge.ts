/**
 * /benchmark —— LLM-as-judge 评测（对应 OpenSeeker eval.py）。
 * 给定 question + ground truth + agent answer，输出 {correct, score, rationale}。
 */
import { llmComplete } from './llm.js'
import { truncate } from './estimate.js'
import type { JudgeResult, Trajectory } from './types.js'

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator for a deepsearch benchmark.

Given a research question, the ground-truth answer, and a model's final answer, judge whether the model's answer is correct.

Scoring rubric (score 0-10):
- 9-10: fully correct, precise and complete
- 7-8: correct in substance, minor imprecision or missing detail
- 4-6: partially correct, some key element wrong or missing
- 1-3: mostly wrong, barely touches the answer
- 0: completely wrong or empty

A "correct" answer must contain the ground-truth entity/fact even if phrased differently.
Reply with ONLY a single JSON object, no markdown:
{"correct": true, "score": 8.0, "rationale": "short justification"}`

/**
 * 评测一条 trajectory。失败返回 null（由 runner 决定是否重试）。
 */
export async function judgeTrajectory(
  trajectory: Trajectory,
  opts: { model?: string; maxTokens?: number; maxRetries?: number } = {},
): Promise<JudgeResult | null> {
  const { model, maxTokens = 1024, maxRetries = 2 } = opts
  const userPrompt =
    `Research question:\n${trajectory.query}\n\n` +
    `Ground-truth answer:\n${trajectory.gt}\n\n` +
    `Model's final answer:\n${truncate(trajectory.answer, 2000)}`

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await llmComplete(JUDGE_SYSTEM_PROMPT, userPrompt, {
        ...(model ? { model } : {}),
        maxTokens,
      })
      const json = res.text.match(/\{[\s\S]*\}/)?.[0]
      if (!json) continue
      const parsed = JSON.parse(json) as Partial<JudgeResult>
      if (typeof parsed.correct !== 'boolean' || typeof parsed.score !== 'number') continue
      return {
        correct: parsed.correct,
        score: Math.max(0, Math.min(10, parsed.score)),
        rationale: truncate(parsed.rationale ?? '', 500),
      }
    } catch {
      if (attempt === maxRetries - 1) return null
    }
  }
  return null
}