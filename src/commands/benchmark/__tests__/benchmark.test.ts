import { describe, expect, test } from 'bun:test'
import { estimateTokens, stripTags, truncate } from '../estimate.js'
import { analyzeContextFromSteps } from '../ctx.js'
import { WORKING_CONTEXT_TARGET } from '../types.js'
import type { StepScore, Trajectory } from '../types.js'
import { buildReportToolResultMessages } from '../benchmark.js'

describe('estimateTokens', () => {
  test('english ~4 chars/token', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0)
    expect(estimateTokens('hello world')).toBe(3)
  })
  test('cjk chars count ~0.8/token', () => {
    const cjk = estimateTokens('你好世界')
    expect(cjk).toBe(3)
  })
  test('empty is 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('stripTags', () => {
  test('removes html', () => {
    expect(stripTags('<p>hello <b>world</b></p>')).toBe('hello world')
  })
  test('decodes entities', () => {
    expect(stripTags('a &amp; b &lt;c&gt;')).toBe('a & b <c>')
  })
})

describe('truncate', () => {
  test('cuts long strings', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde…')
  })
  test('keeps short strings', () => {
    expect(truncate('abc', 5)).toBe('abc')
  })
})

describe('analyzeContextFromSteps', () => {
  function mkTrajectory(steps: Trajectory['steps'], scores: StepScore[] = []): Trajectory {
    return {
      id: 't',
      query: 'q',
      gt: 'g',
      model: 'm',
      answer: 'a',
      steps,
      stepScores: scores,
      judged: null,
      startedAt: '',
      durationMs: 0,
      naturallyAnswered: false,
    }
  }

  test('stays under threshold → no threshold suggestion', () => {
    const steps = [1, 2, 3].map(i => ({
      step: i,
      reasoning: 'r',
      action: 'search_web' as const,
      actionInput: 'x',
      toolResult: 'y'.repeat(400),
      llmTokensIn: 0,
      llmTokensOut: 0,
      llmDurationMs: 0,
      contextTokensBefore: i * 500,
      contextTokensAfter: i * 500 + 400,
    }))
    const analysis = analyzeContextFromSteps(mkTrajectory(steps))
    expect(analysis.thresholdExceededAtStep).toBe(0)
    expect(analysis.finalTokens).toBeGreaterThan(analysis.peakTokens - 400)
  })

  test('harmful step → delete suggestion', () => {
    const steps = [1, 2].map(i => ({
      step: i,
      reasoning: 'r',
      action: 'search_web' as const,
      actionInput: 'x',
      toolResult: 'y'.repeat(600), // cost > 800 tokens after
      llmTokensIn: 0,
      llmTokensOut: 0,
      llmDurationMs: 0,
      contextTokensBefore: i * 2000,
      contextTokensAfter: i * 2000 + 600,
    }))
    const scores: StepScore[] = [
      { step: 1, action: 'search_web', score: -0.8, isAnchor: false, verdict: 'harmful', rationale: 'detour' },
    ]
    const analysis = analyzeContextFromSteps(mkTrajectory(steps, scores))
    const deletes = analysis.suggestions.filter(s => s.kind === 'delete')
    expect(deletes.length).toBe(1)
    expect(deletes[0]!.step).toBe(1)
  })

  test('high-ctx trajectory exceeds working target → compress suggestion', () => {
    const steps = [WORKING_CONTEXT_TARGET + 1000, WORKING_CONTEXT_TARGET + 2000].map((ctx, i) => ({
      step: i + 1,
      reasoning: 'r',
      action: 'search_web' as const,
      actionInput: 'x',
      toolResult: 'y',
      llmTokensIn: 0,
      llmTokensOut: 0,
      llmDurationMs: 0,
      contextTokensBefore: ctx,
      contextTokensAfter: ctx,
    }))
    const analysis = analyzeContextFromSteps(mkTrajectory(steps))
    expect(analysis.thresholdExceededAtStep).toBe(1)
    expect(analysis.suggestions.some(s => s.kind === 'compress')).toBe(true)
  })
})

describe('buildReportToolResultMessages', () => {
  const args = {
    dataset: 'deepsearch-demo',
    model: 'openai/gpt-oss-120b',
    judgeModel: '',
    maxSteps: 8,
    limit: Infinity,
  }

  test('produces a paired assistant tool_use + user tool_result', () => {
    const { toolUseId, assistant, user } = buildReportToolResultMessages(
      args,
      '📊 deepsearch benchmark report — deepsearch-demo\n...',
    )
    expect(toolUseId.startsWith('toolu_')).toBe(true)

    const toolUse = assistant.message.content[0]
    expect(toolUse).toMatchObject({
      type: 'tool_use',
      name: 'deepsearch',
      input: {
        dataset: 'deepsearch-demo',
        model: 'openai/gpt-oss-120b',
        maxSteps: 8,
      },
    })

    const toolResult = user.message.content[0]
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      tool_use_id: toolUseId,
    })
    // user 消息通过 sourceToolAssistantUUID 关联到 assistant（配对不被 strip）
    expect(user.sourceToolAssistantUUID).toBe(assistant.uuid)
  })

  test('includes judgeModel only when set and different from model', () => {
    const withJudge = buildReportToolResultMessages(
      { ...args, judgeModel: 'judge-x' },
      'r',
    )
    const input = withJudge.assistant.message.content[0]
    expect(input.type === 'tool_use' && input.input).toMatchObject({
      judgeModel: 'judge-x',
    })

    const sameAsModel = buildReportToolResultMessages(
      { ...args, judgeModel: args.model },
      'r',
    )
    const input2 = sameAsModel.assistant.message.content[0]
    expect(
      input2.type === 'tool_use' &&
        'judgeModel' in (input2.input as Record<string, unknown>),
    ).toBe(false)
  })

  test('includes limit only when finite', () => {
    const finite = buildReportToolResultMessages(
      { ...args, limit: 2 },
      'r',
    )
    const input = finite.assistant.message.content[0]
    expect(input.type === 'tool_use' && input.input).toMatchObject({
      limit: 2,
    })

    const infinite = buildReportToolResultMessages(args, 'r')
    const input2 = infinite.assistant.message.content[0]
    expect(
      input2.type === 'tool_use' &&
        'limit' in (input2.input as Record<string, unknown>),
    ).toBe(false)
  })
})