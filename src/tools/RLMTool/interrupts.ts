/**
 * The interrupt surface: what the worker can ask the host for mid-exec, and how each
 * request is turned into a reply frame.
 *
 * Wire reply shapes the Python worker reduces:
 *   - single:  { response: string }  or { error }
 *   - batch:   { responses: string[] } or { error }
 *
 * Port of rlm.pi/pi-plugin/rlm/src/sandbox/interrupts.ts — the kinds this bridge serves:
 * llm_query / rlm_query / llm_batch / rlm_batch / add_context / skill_search / ledger_claims.
 */

import type { WorkerInterrupt } from './protocol.js'
import { writeContextTempFile } from './context-file.js'

/** Result of a host-side pack requested by `add_context`. */
export interface AddContextResult {
  readonly payload: unknown
  readonly files: number
  readonly chars: number
  readonly sourceId: string
  readonly pathPrefix: string
  readonly alreadyLoaded: boolean
  readonly documents: number
  readonly converted: number
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
}

/** Handlers the bridge installs — canonical names only. */
export interface SubcallHandlers {
  llmQuery(prompt: string, depth: number): Promise<unknown>
  llmBatch(prompts: readonly string[], depth: number): Promise<unknown>
  rlmQuery(task: string, depth: number): Promise<unknown>
  rlmBatch(tasks: readonly string[], depth: number): Promise<unknown>
  addContext(source: string, depth: number): Promise<AddContextResult>
}

const UNCONFIGURED = 'sub-LLM bridge not configured'

function rejectBatch(items: readonly string[]): Promise<readonly string[]> {
  return Promise.resolve(Object.freeze(items.map(() => UNCONFIGURED)))
}

export const REJECT: SubcallHandlers = Object.freeze({
  llmQuery: async () => UNCONFIGURED,
  llmBatch: rejectBatch,
  rlmQuery: async () => UNCONFIGURED,
  rlmBatch: rejectBatch,
  addContext: async () => { throw new Error('add_context not configured') },
})

export interface ReplyBody {
  readonly response?: string
  readonly responses?: readonly string[]
  readonly error?: string
  // add_context fields
  readonly path?: string
  readonly json?: boolean
  readonly files?: number
  readonly chars?: number
  readonly source_id?: string
  readonly path_prefix?: string
  readonly already_loaded?: boolean
  readonly documents?: number
  readonly converted?: number
  readonly skipped?: readonly { readonly path: string; readonly reason: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function formatError(msg: string): string {
  return `[rlm] ${msg}`
}

/** Resolve a handler return value to a single `response` string for the worker. */
async function resolveSingle(raw: unknown): Promise<ReplyBody> {
  if (typeof raw === 'string') return { response: raw }
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    return { response: String(raw) }
  }
  if (isRecord(raw) && typeof raw.ok === 'boolean') {
    // SpawnResult-shaped: { ok, task_id, result?, error? } — await already folded in.
    if (raw.ok && typeof raw.result === 'string') return { response: raw.result }
    const err = typeof raw.error === 'string' ? raw.error : 'spawn failed'
    return { error: err, response: formatError(err) }
  }
  return { response: typeof raw === 'string' ? raw : '' }
}

/** Resolve a handler return value to `responses: string[]` for the worker batch reducer. */
async function resolveBatch(raw: unknown, expectedN: number): Promise<ReplyBody> {
  if (Array.isArray(raw)) {
    return { responses: Object.freeze(raw.map((x: unknown) => (typeof x === 'string' ? x : String(x)))) }
  }
  const msg = formatError('malformed batch handler result')
  if (isRecord(raw) && typeof raw.ok === 'boolean' && Array.isArray(raw.results)) {
    return { responses: Object.freeze(raw.results.map(String)) }
  }
  return {
    error: 'malformed batch handler result',
    responses: Object.freeze(Array.from({ length: Math.max(1, expectedN) }, () => msg)),
  }
}

/**
 * Service one interrupt and hand the reply body to `reply`.
 * Errors are replied, never thrown.
 */
export async function serviceInterrupt(
  msg: WorkerInterrupt,
  h: SubcallHandlers,
  reply: (rid: string, body: ReplyBody) => void,
): Promise<void> {
  const d = msg.depth

  try {
    switch (msg.type) {
      case 'llm_query': {
        const raw = await h.llmQuery(msg.prompt ?? '', d)
        reply(msg.rid, await resolveSingle(raw))
        return
      }
      case 'rlm_query': {
        const raw = await h.rlmQuery(msg.prompt ?? '', d)
        reply(msg.rid, await resolveSingle(raw))
        return
      }
      case 'llm_batch': {
        const prompts = msg.prompts ?? []
        const raw = await h.llmBatch(prompts, d)
        reply(msg.rid, await resolveBatch(raw, prompts.length))
        return
      }
      case 'rlm_batch': {
        const tasks = msg.tasks ?? msg.prompts ?? []
        const raw = await h.rlmBatch(tasks, d)
        reply(msg.rid, await resolveBatch(raw, tasks.length))
        return
      }
      case 'add_context': {
        const lib = await h.addContext(msg.source ?? '', d)
        if (lib.alreadyLoaded) {
          reply(msg.rid, {
            already_loaded: true,
            files: 0,
            chars: lib.chars,
            source_id: lib.sourceId,
            path_prefix: lib.pathPrefix,
            documents: lib.documents,
            converted: lib.converted,
            skipped: lib.skipped,
          })
          return
        }
        const { path: filePath, json: isJson } = await writeContextTempFile(lib.payload)
        reply(msg.rid, {
          path: filePath,
          json: isJson,
          files: lib.files,
          chars: lib.chars,
          source_id: lib.sourceId,
          path_prefix: lib.pathPrefix,
          documents: lib.documents,
          converted: lib.converted,
          skipped: lib.skipped,
        })
        return
      }
      default: {
        const _exhaustive: never = msg
        reply((_exhaustive as WorkerInterrupt).rid, { error: 'unknown interrupt type' })
      }
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    reply(msg.rid, { error, response: formatError(error) })
  }
}

