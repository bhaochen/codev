/**
 * /benchmark —— ReAct deepsearch agent（参考 OpenSeeker/ABSeeker 的文本式
 * tool loop：search_web / visit_web，<tool_call> / <answer> 标记）。
 *
 * transcript 每次增长后整体作为一条 user 消息发给 LLM，因此每一步都能获得
 * 完整的 search context（这也是 LongSeeker 观察的「长程 context 增长」来源）。
 */
import { estimateTokens, truncate } from './estimate.js'
import { llmComplete } from './llm.js'
import { formatHits, visitPage, webSearch } from './search.js'
import type { AgentAction, BenchmarkStep, Trajectory } from './types.js'

const AGENT_SYSTEM_PROMPT = `You are a deep research agent. Answer the user's question by searching the web.

Available tools:
- search_web: {"name": "search_web", "input": {"query": "..."}} — web search for a keyword query
- visit_web:  {"name": "visit_web",  "input": {"url": "..."}}    — open a URL from a search result

Every turn you must respond with EXACTLY ONE of:
1. A tool call wrapped in a <tool_call> tag:
   <tool_call>{"name": "search_web", "input": {"query": "..."}}</tool_call>
   or
   <tool_call>{"name": "visit_web", "input": {"url": "..."}}</tool_call>
2. Your final answer wrapped in an <answer> tag:
   <answer>the final answer to the question</answer>

Guidelines:
- Start with a search_web call to break the question down.
- Open the most promising pages with visit_web to read the details.
- Work incrementally: each tool call must move you closer to the answer.
- Put any reasoning before the tag, then end your turn with the single <tool_call> or <answer> tag as the LAST line.
- Do NOT output anything else after the closing </tool_call> or </answer> tag.
- When you have enough evidence, answer concisely with <answer>.`

export const MAX_MALFORMED = 3

export type ParsedOutput =
  | { kind: 'tool'; name: 'search_web' | 'visit_web'; input: Record<string, unknown> }
  | { kind: 'answer'; answer: string }

/** 从模型输出里取出最后一个 action（thinking 夹杂也不影响） */
export function parseAgentOutput(text: string): ParsedOutput | null {
  const lastTool = [...text.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)].at(-1)?.[1]
  if (lastTool) {
    try {
      const parsed = JSON.parse(lastTool) as { name?: unknown; input?: unknown }
      if (
        (parsed.name === 'search_web' || parsed.name === 'visit_web') &&
        parsed.input &&
        typeof parsed.input === 'object'
      ) {
        return {
          kind: 'tool',
          name: parsed.name,
          input: parsed.input as Record<string, unknown>,
        }
      }
    } catch {
      // fall through to answer detection
    }
  }
  const answer = [...text.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].at(-1)?.[1]?.trim()
  if (answer) return { kind: 'answer', answer }
  return null
}

export type RunAgentOptions = {
  model: string
  maxSteps: number
  maxTranscriptTokens: number
  onStep?: (trajectory: Trajectory) => void
}

/** 构造带本步信息、供 UI 展示/保存的中间 trajectory */
function snapshot(t: Trajectory): Trajectory {
  return { ...t, steps: [...t.steps] }
}

/** 跑一个 query 的 ReAct 搜索循环，产出一条 trajectory */
export async function runAgent(
  item: { id: string; query: string; gt: string },
  opts: RunAgentOptions,
): Promise<Trajectory> {
  const { model, maxSteps, maxTranscriptTokens, onStep } = opts
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  const steps: BenchmarkStep[] = []
  let malformed = 0
  let naturallyAnswered = false
  let answer = ''
  let error: string | undefined

  let transcript = `Question: ${item.query}\n\n`
  const emit = (t: Trajectory) => {
    onStep?.(snapshot(t))
  }

  for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {
    const contextTokensBefore = estimateTokens(transcript)
    let res: Awaited<ReturnType<typeof llmComplete>> | null = null
    let text = ''
    let llmError: string | undefined

    try {
      res = await llmComplete(AGENT_SYSTEM_PROMPT, transcript, {
        model,
        maxTokens: 2048,
      })
      text = res.text
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err)
      malformed += 1
    }

    let reasoning = (text || '').trim()
    const parsed = !llmError ? parseAgentOutput(text) : null
    let action: AgentAction = 'error'
    let actionInput = ''
    let resultText = ''

    if (llmError) {
      action = 'error'
      resultText = `Error: LLM call failed (${llmError})`
    } else if (!parsed) {
      malformed += 1
      action = 'error'
      resultText =
        'Error: Could not parse your output. Wrap exactly one <tool_call> JSON </tool_call> or <answer>...</answer> tag as the last line, and nothing after it.'
      reasoning = truncate(reasoning, 1500) || '(empty output)'
    } else if (parsed.kind === 'answer') {
      answer = parsed.answer
      naturallyAnswered = true
      action = 'answer'
      actionInput = parsed.answer
      resultText = `[final answer] ${parsed.answer}`
      reasoning = truncate(reasoning, 1500)
    } else {
      action = parsed.name
      actionInput =
        parsed.name === 'search_web'
          ? String(parsed.input.query ?? '')
          : String(parsed.input.url ?? '')
      if (!actionInput) {
        resultText = 'Error: missing query or url in tool call'
      } else {
        // 工具执行失败不能杀掉整个 benchmark：变成一步 error 继续
        try {
          resultText =
            parsed.name === 'search_web'
              ? formatHits(actionInput, await webSearch(actionInput))
              : await visitPage(actionInput)
        } catch (toolErr) {
          const msg = toolErr instanceof Error ? toolErr.message : String(toolErr)
          resultText = `Error: ${msg}`
        }
      }
      reasoning = truncate(reasoning, 1500)
    }

    const step: BenchmarkStep = {
      step: stepNum,
      reasoning,
      action,
      actionInput,
      toolResult: truncate(resultText, 2000),
      llmTokensIn: res?.tokensIn ?? 0,
      llmTokensOut: res?.tokensOut ?? 0,
      llmDurationMs: res?.durationMs ?? 0,
      contextTokensBefore,
      contextTokensAfter: contextTokensBefore + estimateTokens(resultText),
    }
    steps.push(step)

    transcript += `\n\n[step ${stepNum}]\n`
    transcript += `Assistant reasoning:\n${reasoning}\n\n`
    transcript += `[tool result] ${truncate(resultText, 2000)}\n\n`

    if (naturallyAnswered) break

    if (malformed >= MAX_MALFORMED) {
      error = `stopped after ${malformed} failed or unparseable outputs`
      break
    }
    if (estimateTokens(transcript) >= maxTranscriptTokens) {
      error = `transcript grew past ${maxTranscriptTokens} estimated tokens`
      break
    }

    emit({
      id: item.id,
      query: item.query,
      gt: item.gt,
      model,
      answer: '',
      steps,
      stepScores: [],
      judged: null,
      startedAt,
      durationMs: Date.now() - startedMs,
      naturallyAnswered: false,
    })
  }

  // 用尽 maxSteps 还没产出 answer：强制收尾
  if (!naturallyAnswered && !error) {
    const contextTokensBefore = estimateTokens(transcript)
    const res = await llmComplete(
      AGENT_SYSTEM_PROMPT,
      transcript +
        `\n\n---\n\nYou have exhausted all ${maxSteps} steps. Give the final answer to the original question now, wrapped as:\n<answer>...</answer>`,
      { model, maxTokens: 1024 },
    ).catch(() => null)
    const forcedText = res?.text ?? ''
    const parsed = parseAgentOutput(forcedText)
    const finalAnswer =
      (parsed?.kind === 'answer' ? parsed.answer : '') ||
      truncate(forcedText.trim(), 300) ||
      '(no answer)'
    answer = finalAnswer
    steps.push({
      step: steps.length + 1,
      reasoning: '',
      action: 'answer',
      actionInput: finalAnswer,
      toolResult: '',
      llmTokensIn: res?.tokensIn ?? 0,
      llmTokensOut: res?.tokensOut ?? 0,
      llmDurationMs: res?.durationMs ?? 0,
      contextTokensBefore,
      contextTokensAfter: contextTokensBefore,
    })
  }

  const trajectory: Trajectory = {
    id: item.id,
    query: item.query,
    gt: item.gt,
    model,
    answer,
    steps,
    stepScores: [],
    judged: null,
    startedAt,
    durationMs: Date.now() - startedMs,
    naturallyAnswered,
    error,
  }
  emit(trajectory)
  return trajectory
}