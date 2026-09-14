/**
 * RLM mode controller — module-level singleton managing the enabled state.
 *
 * Behavior (pi native-mode semantics): when enabled, the system prompt carries RLM
 * guidance and the root agent uses the RLM tool; when disabled, in-flight runs are
 * aborted and normal mode resumes.
 */

import type { RlmConfig } from './types.js'

const DEFAULT_CONFIG: RlmConfig = {
  maxDepth: 3,
  maxIterations: 12,
  execTimeoutS: 600,
  requestTimeoutMs: 20 * 60_000,
  maxPromptChars: 400_000,
  python: 'python3',
  sandboxInitTimeoutMs: 30_000,
  compaction: true,
  smartReasoning: undefined,
  rootSampling: { maxTokens: 16_384 },
  enableVerificationNudge: true,
}

class RlmController {
  private enabled = false
  private readonly config: RlmConfig
  private inFlightAbort: AbortController | null = null

  constructor(config: RlmConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  isEnabled(): boolean {
    return this.enabled
  }

  isBusy(): boolean {
    return this.inFlightAbort !== null
  }

  /** The effective engine config (assembled once at startup). */
  getConfig(): RlmConfig {
    return this.config
  }

  /**
   * Toggle RLM mode. When disabling with a run in flight, aborts it.
   * Returns the new enabled state.
   */
  toggle(): boolean {
    if (this.enabled && this.inFlightAbort) {
      this.inFlightAbort.abort()
      this.inFlightAbort = null
    }
    this.enabled = !this.enabled
    return this.enabled
  }

  /** Claim the in-flight abort controller for an RLM run. */
  begin(): AbortSignal {
    if (this.inFlightAbort) {
      this.inFlightAbort.abort()
    }
    this.inFlightAbort = new AbortController()
    return this.inFlightAbort.signal
  }

  /** Release the in-flight claim (run finished or errored). */
  end(): void {
    this.inFlightAbort = null
  }

  /** Abort any in-flight run. */
  abort(): void {
    this.inFlightAbort?.abort()
    this.inFlightAbort = null
  }
}

/** Module-level singleton — one mode per process. */
export const rlmController = new RlmController()

/** RLM guidance appended to the root agent's system prompt while mode is enabled. */
export function rlmSystemPromptAddendum(): string {
  return [
    '# RLM mode',
    '',
    'You are operating in RLM (Recursive Language Model) mode. For tasks that benefit from',
    'recursive decomposition — exploring a large codebase, running Python in a persistent sandbox,',
    'delegating sub-problems to sub-LLMs — use the `RLM` tool with a focused prompt. The RLM',
    'sandbox carries the packed working directory in `context` and supports search, sub-LLM',
    'calls (llm_query/rlm_query), and persistent variables. Use it for analysis tasks, not for',
    'file edits (keep using the direct tools for those).',
  ].join('\n')
}