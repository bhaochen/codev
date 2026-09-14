/**
 * Shared configuration + runtime types for the RLM engine.
 */

export interface Sampling {
  readonly maxTokens?: number
  readonly temperature?: number
  /** Engine reasoning level string (mapped to ThinkingConfig by adapter). Undefined = disabled. */
  readonly reasoning?: string
}

export interface RlmConfig {
  /** Max recursion depth. depth >= maxDepth => rlm_query falls back to a plain llm_query. */
  readonly maxDepth: number
  /** Max turns before the engine must finalize. */
  readonly maxIterations: number
  /** Per-repl-block wall-clock timeout inside the worker (seconds). */
  readonly execTimeoutS: number
  /** Parent-side watchdog per sandbox request (ms). */
  readonly requestTimeoutMs: number
  /** Reject sub-LLM prompts larger than this many chars. */
  readonly maxPromptChars: number
  /** Python executable used to launch the sandbox worker. */
  readonly python: string
  /** Worker startup wait before treating sandbox init as failed (ms). */
  readonly sandboxInitTimeoutMs: number
  /** Summarize the trajectory when it grows past the threshold. */
  readonly compaction: boolean
  /** ThinkingLevel for the root smart model. */
  readonly smartReasoning?: string
  /** Output token cap + temperature for the root smart model per turn. */
  readonly rootSampling?: Readonly<Sampling>
  /** Coach an early bare-answer finalize once (verification nudge). */
  readonly enableVerificationNudge: boolean
}

/** Input to a headless RLM run. */
export interface RlmInput {
  readonly rootPrompt: string
  readonly context: unknown
  readonly depth: number
}

/** Result of a completed RLM run. */
export interface RlmResult {
  readonly answer: string
  readonly iterations: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly durationMs: number
  readonly lastStdout: string
}

/** A function that runs an RLM to completion — used to wire recursion. */
export type RunRlm = (input: RlmInput) => Promise<RlmResult>
