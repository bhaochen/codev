/**
 * RLM engine — the headless RLM loop.
 *
 * Each call owns a fresh sandbox, drives the root model turn-by-turn over ```repl``` blocks,
 * services `llm_query`/`rlm_query` via the interrupts, and stops when the model submits an
 * answer or a turn cap is hit. Recursion is wired by giving the sandbox rlm handlers
 * that call back into `run` at depth+1.
 */

import type { ChatMsg, AdapterDeps, Usage, CompleteResult, CompleteFn } from './adapter.js'
import { adapterComplete } from './adapter.js'
import type { SubcallHandlers } from './interrupts.js'
import { type ReplResult } from './protocol.js'
import { PythonSandbox, SANDBOX_WATCHDOG_HEARTBEAT_MS } from './sandbox.js'
import { findReplBlocks } from './parsing.js'
import { contextLength, contextSizeStats, contextTypeLabel } from './tokens.js'
import { finalAnswerOf, formatReplOutputs, latestAnswerContentOf, latestStdoutOf, turnHadError } from './answer.js'
import { compactHistory, elideOldToolPayloads, shouldCompact } from './compaction.js'
import { buildRlmSystemPrompt } from './system-prompt.js'
import { buildAddContextHandler } from './add-context.js'
import { buildTurnPrompt, FINALIZE_PROMPT, RETRIEVAL_NUDGE, VERIFICATION_NUDGE } from './prompts.js'
import { appendUserMessage } from './history.js'
import { runTurn } from './iteration.js'
import type { RlmConfig, RlmInput, RlmResult, RunRlm } from './types.js'

const DETACHED_SETTLE_MS = 5_000
const VERIFICATION_NUDGE_TURN_CAP = 4

export interface EngineDeps {
  readonly config: RlmConfig
  readonly adapter: AdapterDeps
  readonly signal?: AbortSignal
  /** Test-only override for model completion. */
  readonly complete?: CompleteFn
  /** Progress / event callback — emitted at turn boundaries and run completion. */
  readonly onEvent?: (event: RlmProgress) => void
  /** Called with each completion's usage (root + sub-LLM). */
  readonly onUsage?: (usage: Usage, role: 'root' | 'sub') => void
  /** Working directory for add_context source resolution. Defaults to process.cwd(). */
  readonly cwd?: string
}

export interface RlmProgress {
  readonly type: 'rlm_progress'
  readonly phase: 'start' | 'turn' | 'model' | 'python' | 'subcall' | 'answer' | 'done' | 'error'
  readonly depth?: number
  readonly turn?: number
  readonly maxTurns?: number
  readonly detail?: string
  readonly code?: string
  readonly stdout?: string
  readonly stderr?: string
  readonly executionTimeMs?: number
  readonly varNames?: readonly string[]
  readonly prompt?: string
  readonly response?: string
  readonly usage?: Usage
}

const TRACE_TEXT_LIMIT = 1_600

function traceText(value: string): string {
  const text = value.trim()
  return text.length > TRACE_TEXT_LIMIT ? `${text.slice(0, TRACE_TEXT_LIMIT)}…` : text
}

/** Build the default complete function from the adapter deps. */
function defaultComplete(adapter: AdapterDeps): CompleteFn {
  return (history: readonly ChatMsg[], sampling) => adapterComplete(history, sampling, adapter)
}

/**
 * Create an RLM engine bound to the given deps.
 * The returned function is reused for recursion.
 */
export function createEngine(deps: EngineDeps): RunRlm {
  const { config, signal, onEvent, onUsage, cwd = process.cwd() } = deps
  const complete = deps.complete ?? defaultComplete(deps.adapter)

  /** Build subcall handlers bound to a run's live context and engine re-entry.
   *  `trackDetached` keeps the parent watchdog alive while a sub-call is being serviced.
   *  addContext is layered on at the call site (it needs cwd + onLoaded). */
  function buildSubcallHandlers(
    runChild: RunRlm,
    getContext: () => unknown,
    trackDetached: <T>(task: () => Promise<T>) => Promise<T>,
    depth: number,
  ): Pick<SubcallHandlers, 'llmQuery' | 'llmBatch' | 'rlmQuery' | 'rlmBatch'> {

    /** Sub-LLM single-shot query — blocking handler for a sandbox interrupt. */
    async function subLlmQuery(prompt: string): Promise<string> {
      onEvent?.({
        type: 'rlm_progress',
        phase: 'subcall',
        depth,
        detail: `sub-LLM request (depth ${depth})`,
        prompt: traceText(prompt),
      })
      const { text, usage } = await complete([{ role: 'user', content: prompt }], {
        maxTokens: 1024,
        temperature: 0,
      })
      onUsage?.(usage, 'sub')
      onEvent?.({
        type: 'rlm_progress',
        phase: 'subcall',
        depth,
        detail: `sub-LLM response · ${usage.output} tokens`,
        prompt: traceText(prompt),
        response: traceText(text),
        usage,
      })
      return text
    }


    /** Sub-LLM batch — parallel single-shot queries. */
    async function subLlmBatch(prompts: readonly string[]): Promise<readonly string[]> {
      return Promise.all(prompts.map((p) => subLlmQuery(p)))
    }

    return {
      llmQuery: (prompt) => trackDetached(() => subLlmQuery(prompt)),
      llmBatch: (prompts) => trackDetached(() => subLlmBatch(prompts)),
      rlmQuery: (task, depth) =>
        trackDetached(() => {
          if (depth + 1 >= config.maxDepth) return subLlmQuery(task)
          return runChild({ rootPrompt: task, context: getContext(), depth: depth + 1 }).then((r) => r.answer)
        }),
      rlmBatch: (tasks, depth) =>
        trackDetached(() =>
          Promise.all(tasks.map((t) => {
            if (depth + 1 >= config.maxDepth) return subLlmQuery(t)
            return runChild({ rootPrompt: t, context: getContext(), depth: depth + 1 }).then((r) => r.answer)
          })),
        ),
    }
  }

  const run: RunRlm = async (input: RlmInput): Promise<RlmResult> => {
    onEvent?.({ type: 'rlm_progress', phase: 'start', depth: input.depth, detail: (input.rootPrompt ?? '').slice(0, 60) })
    onEvent?.({ type: 'rlm_progress', phase: 'turn', depth: input.depth, turn: 0, maxTurns: config.maxIterations })

    let liveContext: unknown = input.context ?? []

    // --- helpers ---------------------------------------------------------

    let sandbox: PythonSandbox | undefined
    let detachedInFlight = 0
    let detachedIdle: (() => void) | undefined
    const settleDetached = async (): Promise<void> => {
      if (detachedInFlight === 0) return
      await new Promise<void>((resolve) => {
        detachedIdle = resolve
        setTimeout(resolve, DETACHED_SETTLE_MS).unref?.()
      })
      detachedIdle = undefined
    }
    /** Bump the detached counter around a sub-call so the watchdog stays alive while the
     *  host is servicing it, and settleDetached/refreshWatchdog see real in-flight work. */
    const trackDetached = async <T>(task: () => Promise<T>): Promise<T> => {
      detachedInFlight += 1
      try {
        return await task()
      } finally {
        detachedInFlight -= 1
        if (detachedInFlight === 0) detachedIdle?.()
      }
    }
    const watchdogHeartbeat = setInterval(() => {
      if (detachedInFlight > 0) sandbox?.refreshWatchdog()
    }, SANDBOX_WATCHDOG_HEARTBEAT_MS)
    watchdogHeartbeat.unref?.()

    let best = ''
    let lastStdout = ''
    let completedTurns = 0
    let nodeStatus: 'done' | 'error' = 'done'
    let sawRetrieval = false
    let retrievalNudged = false
    let verificationNudged = false
    let verificationNudgePending = false

    const rootSampling = {
      maxTokens: config.rootSampling?.maxTokens,
      temperature: config.rootSampling?.temperature,
      reasoning: config.rootSampling?.reasoning ?? config.smartReasoning,
    }

    try {
      // --- system prompt -------------------------------------------------
      const meta = {
        contextType: contextTypeLabel(input.context),
        contextChars: contextLength(input.context),
        contextStats: contextSizeStats(input.context),
        rootPrompt: input.rootPrompt || undefined,
      }
      const systemPrompt = buildRlmSystemPrompt(meta, {
        orchestrator: true,
        recursion: input.depth + 1 < config.maxDepth,
        maxPromptChars: config.maxPromptChars,
        child: input.depth > 0,
        delegation: input.depth > 0,
        depth: input.depth,
      })

      // --- build subcall handlers BEFORE sandbox so interrupts resolve ---
      let history: ChatMsg[] = [{ role: 'system', content: systemPrompt }]
      let pendingReplOutputs: string | undefined

      const subcalls = {
        ...buildSubcallHandlers(run, () => liveContext, trackDetached, input.depth),
        // add_context: pack a source on the host, append it into the live context (children
        // inherit the grown world), and let the worker read the temp file.
        ...buildAddContextHandler(
          { cwd, signal },
          () => liveContext,
          (payload) => {
            const current = Array.isArray(liveContext) ? (liveContext as readonly unknown[]) : []
            liveContext = [...current, ...payload]
          },
        ).handlers,
      }

      // --- sandbox -------------------------------------------------------
      sandbox = await PythonSandbox.spawn({
        depth: input.depth,
        surface: input.depth > 0 ? 'child' : 'root',
        execTimeoutS: config.execTimeoutS,
        requestTimeoutMs: config.requestTimeoutMs,
        python: config.python,
        signal,
        initTimeoutMs: config.sandboxInitTimeoutMs,
        handlers: subcalls,
      })

      // Context is already a sandbox-ready list.
      liveContext = input.context ?? []
      if (Array.isArray(liveContext) && liveContext.length > 0) {
        await sandbox.loadContext(liveContext)
      }

      // --- main loop -----------------------------------------------------
      for (let i = 0; i < config.maxIterations; i++) {
        onEvent?.({ type: 'rlm_progress', phase: 'turn', depth: input.depth, turn: i + 1, maxTurns: config.maxIterations })

        if (config.compaction) {
          history = elideOldToolPayloads(history)
          if (shouldCompact(history)) {
            history = await compactHistory(history, complete)
          }
        }

        if (pendingReplOutputs) {
          appendUserMessage(history, pendingReplOutputs)
          pendingReplOutputs = undefined
        }

        const nudgeNow = i >= 2 && !sawRetrieval && !retrievalNudged
        if (nudgeNow) retrievalNudged = true
        const notes = [
          nudgeNow ? RETRIEVAL_NUDGE : undefined,
          verificationNudgePending ? VERIFICATION_NUDGE : undefined,
        ]
          .filter((s): s is string => s !== undefined)
          .join('\n\n') || undefined
        verificationNudgePending = false

        appendUserMessage(history, buildTurnPrompt(i, config.maxIterations, notes))

        onEvent?.({
          type: 'rlm_progress',
          phase: 'model',
          depth: input.depth,
          turn: i + 1,
          detail: `model turn ${i + 1}`,
        })
        const turn = await runTurn(history, sandbox, complete, {
          sampling: rootSampling,
          signal,
        })

        onEvent?.({
          type: 'rlm_progress',
          phase: 'model',
          depth: input.depth,
          turn: i + 1,
          detail: traceText(turn.response),
          response: traceText(turn.response),
          usage: turn.usage,
        })
        for (let blockIndex = 0; blockIndex < turn.results.length; blockIndex++) {
          const repl = turn.results[blockIndex]!
          onEvent?.({
            type: 'rlm_progress',
            phase: 'python',
            depth: input.depth,
            turn: i + 1,
            detail: `Python Sandbox · block ${blockIndex + 1}/${turn.results.length}`,
            code: traceText(turn.blocks[blockIndex] ?? ''),
            stdout: traceText(repl.stdout),
            stderr: traceText(repl.stderr),
            executionTimeMs: repl.executionTimeMs,
            varNames: repl.varNames,
          })
        }
        if (turn.blocks.some((b) => /\b(?:search|grep_context)\s*\(/.test(b))) sawRetrieval = true

        onUsage?.(turn.usage, 'root')

        const answerContent = latestAnswerContentOf(turn.results)
        if (answerContent) best = answerContent
        else if (!best && turn.response.trim()) best = turn.response

        const turnStdout = latestStdoutOf(turn.results)
        if (turnStdout) lastStdout = turnStdout
        completedTurns = i + 1

        const final = finalAnswerOf(turn.results)
        if (final != null) {
          if (
            config.enableVerificationNudge &&
            !verificationNudged &&
            completedTurns < VERIFICATION_NUDGE_TURN_CAP &&
            isBareAnswer(final)
          ) {
            verificationNudged = true
            verificationNudgePending = true
          } else {
            const done = buildResult(final, i + 1, lastStdout)
            onEvent?.({ type: 'rlm_progress', phase: 'answer', depth: input.depth, detail: final.slice(0, 60) })
            return done
          }
        }

        history.push({ role: 'assistant', content: turn.response })
        pendingReplOutputs = formatReplOutputs(turn.results, turn.skippedBlocks)
      }

      // --- out of turns → finalize --------------------------------------
      if (pendingReplOutputs) appendUserMessage(history, pendingReplOutputs)
      const finalized = buildResult(
        await finalize(history, complete, sandbox),
        completedTurns,
        lastStdout,
      )
      onEvent?.({ type: 'rlm_progress', phase: 'answer', depth: input.depth, detail: finalized.answer.slice(0, 60) })
      return finalized
    } catch (err) {
      if (signal?.aborted) {
        return buildResult(best.trim() || '(aborted)', completedTurns, lastStdout)
      }
      nodeStatus = 'error'
      throw err
    } finally {
      onEvent?.({
        type: 'rlm_progress',
        phase: nodeStatus === 'error' ? 'error' : 'done',
        depth: input.depth,
        detail: nodeStatus === 'error' ? 'run failed' : 'run complete',
      })
      clearInterval(watchdogHeartbeat)
      await settleDetached()
      await sandbox?.dispose()
    }
  }
  return run
}

function buildResult(answer: string, iterations: number, lastStdout: string): RlmResult {
  const final = answer.trim().length > 0 ? answer.trim() : '(no final answer)'
  return {
    answer: final,
    iterations,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    lastStdout,
  }
}

function isBareAnswer(answer: string): boolean {
  const t = answer.trim()
  return t.length <= 12 || /^[-+$(€£¥]?\d+(?:[.,]\d+)*\s*%?$/.test(t)
}

async function finalize(
  history: ChatMsg[],
  complete: CompleteFn,
  sandbox: PythonSandbox,
): Promise<string> {
  const finalHistory = [...history]
  appendUserMessage(finalHistory, FINALIZE_PROMPT)
  const { text } = await complete(finalHistory, undefined)
  const blocks = findReplBlocks(text)
  const results = new Array<ReplResult>(blocks.length)
  for (let i = 0; i < blocks.length; i++) {
    results[i] = await sandbox.exec(blocks[i])
  }
  const final = finalAnswerOf(results) ?? latestAnswerContentOf(results)
  if (final !== null && final.trim() !== '') return final.trim()
  return text.trim()
}
