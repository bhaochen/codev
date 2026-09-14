/**
 * A single RLM turn for the headless engine: ask the root model, parse its ```repl``` blocks,
 * execute each in the sandbox, and return the results.
 *
 * Ported from rlm.pi/pi-plugin/rlm/src/core/iteration.ts.
 */

import type { ChatMsg, CompleteResult, Sampling, Usage } from './adapter.js'
import type { ReplResult } from './protocol.js'
import type { PythonSandbox } from './sandbox.js'
import { findReplBlocks } from './parsing.js'

export interface Turn {
  readonly response: string
  readonly results: readonly ReplResult[]
  readonly usage: Usage
  readonly blocks: readonly string[]
  /** Blocks not executed because an earlier block raised. */
  readonly skippedBlocks: number
}

/** Signature for the completion function — allows test override. */
export type CompleteFn = (messages: readonly ChatMsg[], sampling: Sampling | undefined) => Promise<CompleteResult>

interface TurnDeps {
  readonly sampling?: Sampling
  readonly signal?: AbortSignal
  /** Test-only override for model completion. */
  readonly complete?: CompleteFn
}

export async function runTurn(
  history: readonly ChatMsg[],
  sandbox: PythonSandbox,
  complete: CompleteFn,
  deps: TurnDeps,
): Promise<Turn> {
  const { text, usage } = await complete(history, deps.sampling)

  const blocks = findReplBlocks(text)
  const results = new Array<ReplResult>(blocks.length)
  let executed = 0
  for (let i = 0; i < blocks.length; i++) {
    results[i] = await sandbox.exec(blocks[i], deps.signal)
    executed = i + 1
    if (results[i].raised) break
  }
  results.length = executed
  return { response: text, results, usage, blocks, skippedBlocks: blocks.length - executed }
}
