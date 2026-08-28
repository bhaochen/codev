import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'

/**
 * Generic Tool Call Recovery layer.
 *
 * Every model-emitted `tool_use.input` is validated against the tool's Zod
 * schema BEFORE execution. When validation fails we do NOT fail outright —
 * we classify the issues and apply a graded recovery:
 *
 *   AUTO_REPAIR — a missing/extra field has a deterministic, safe fix (e.g. a
 *                 cosmetic `header` that defaults to "Question", or an extra
 *                 key the strict schema rejects). We repair and re-validate.
 *   RETRY       — the violation cannot be safely auto-fixed (a missing id,
 *                 status, reason, a wrong type, an array-length error, a
 *                 refine/semantic error). We surface a clear error to the
 *                 model so it re-issues the call.
 *   FATAL       — retries exhausted (see MAX_RETRIES). We give up instead of
 *                 looping forever.
 *
 * This keeps the schema as the single source of truth (the Contract) and
 * handles the model's occasional contract violations in code, rather than
 * loosening the schema with `.optional()`.
 */

export const MAX_RETRIES = 2

export type RepairDisposition = 'auto_repair' | 'retry' | 'fatal'

export type RepairActionKind = 'auto_fill' | 'drop_unknown_key' | 'coerce_type'

export interface RepairAction {
  type: string
  path: (string | number)[]
  action: RepairActionKind
  from?: unknown
  to?: unknown
}

export interface RecoveryRecord {
  tool: string
  toolUseID: string
  raw_arguments: unknown
  validation_error: string
  repair: RepairAction | null
  final_arguments: unknown | null
  success: boolean
  disposition: RepairDisposition
  attempt: number
}

export type GuardStatus = 'ok' | 'repaired' | 'retry' | 'fatal'

export interface GuardResult {
  status: GuardStatus
  /** Present when status is 'ok' or 'repaired'. */
  parsedInput?: { success: true; data: unknown }
  /** Present when status is 'retry' or 'fatal'. */
  error?: z.ZodError
  issuesMessage?: string
  disposition: RepairDisposition
  repairs: RepairAction[]
  attempt: number
  recovery: RecoveryRecord
}

// A rule fills a missing required field with a safe default ONLY when the field
// is cosmetic / has a sensible default and omitting it does not change the
// tool's semantics. Semantically-required fields (ids, statuses, goals,
// reasons) are intentionally absent — those go to RETRY, never auto-filled.
interface SafeDefaultRule {
  segments: (string | '*')[]
  value: unknown
}

const SAFE_FIELD_DEFAULTS: Record<string, SafeDefaultRule[]> = {
  AskUserQuestion: [{ segments: ['questions', '*', 'header'], value: 'Question' }],
}

function matchRule(path: readonly (string | number)[], rule: SafeDefaultRule): boolean {
  if (path.length !== rule.segments.length) return false
  return rule.segments.every((seg, i) => seg === '*' || seg === path[i])
}

function getAt(root: unknown, path: readonly (string | number)[]): unknown {
  let cur: unknown = root
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[p]
  }
  return cur
}

function setAt(root: unknown, path: readonly (string | number)[], value: unknown): void {
  if (path.length === 0 || root == null || typeof root !== 'object') return
  let cur = root as Record<string | number, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i]!
    const nextIsIndex = typeof path[i + 1] === 'number'
    if (cur[p] == null || typeof cur[p] !== 'object') {
      cur[p] = nextIsIndex ? [] : {}
    }
    cur = cur[p] as Record<string | number, unknown>
  }
  cur[path[path.length - 1]!] = value
}

interface ZodIssueLike {
  code: string
  path: (string | number)[]
  message: string
  received?: string
  keys?: string[]
}

function applyAutoRepairs(
  toolName: string,
  input: unknown,
  issues: readonly ZodIssueLike[],
): { repaired: unknown; repairs: RepairAction[] } {
  const cloned = structuredClone(input)
  const repairs: RepairAction[] = []

  // 1) Missing required fields with a registered safe default.
  // Zod v4 omits a `received` field on invalid_type issues — the missing
  // value is only described in the message ("received undefined"). Detect a
  // missing field by checking the input value at the issue path is undefined.
  const rules = SAFE_FIELD_DEFAULTS[toolName]
  if (rules) {
    for (const issue of issues) {
      if (
        issue.code === 'invalid_type' &&
        getAt(input, issue.path) === undefined
      ) {
        const path = issue.path
        const rule = rules.find(r => matchRule(path, r))
        if (rule && getAt(cloned, path) === undefined) {
          setAt(cloned, path, rule.value)
          repairs.push({
            type: 'missing_required_default',
            path: [...path],
            action: 'auto_fill',
            to: rule.value,
          })
        }
      }
    }
  }

  // 2) Extra keys rejected by z.strictObject — safe to drop (the model added
  //    noise the schema doesn't accept). This is non-destructive: the accepted
  //    fields are untouched.
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys
      const parent =
        issue.path.length === 0 ? cloned : getAt(cloned, issue.path)
      if (parent && typeof parent === 'object' && keys) {
        for (const k of keys) {
          if (k in (parent as Record<string, unknown>)) {
            delete (parent as Record<string, unknown>)[k]
            repairs.push({
              type: 'unrecognized_key',
              path: [...issue.path, k],
              action: 'drop_unknown_key',
              from: k,
            })
          }
        }
      }
    }
  }

  return { repaired: cloned, repairs }
}

// Retry accounting. Each model retry typically arrives as a fresh tool_use with
// a new id, so we also track a short sliding window per tool name to break
// pathological loops where the model keeps emitting the same bad call.
const attemptByToolUse = new Map<string, number>()
const toolWindow = new Map<string, number[]>()

function recordAttempt(toolUseID: string, toolName: string): {
  attempt: number
  capped: boolean
} {
  const attempt = (attemptByToolUse.get(toolUseID) ?? 0) + 1
  attemptByToolUse.set(toolUseID, attempt)

  const now = Date.now()
  const window = (toolWindow.get(toolName) ?? []).filter(t => now - t < 60_000)
  window.push(now)
  toolWindow.set(toolName, window)

  return { attempt, capped: window.length > MAX_RETRIES }
}

function buildRecord(
  tool: string,
  toolUseID: string,
  raw: unknown,
  validation_error: string,
  repair: RepairAction | null,
  final: unknown | null,
  success: boolean,
  disposition: RepairDisposition,
  attempt: number,
): RecoveryRecord {
  return {
    tool,
    toolUseID,
    raw_arguments: raw,
    validation_error,
    repair,
    final_arguments: final,
    success,
    disposition,
    attempt,
  }
}

/**
 * Validate a model tool_use input and attempt graded recovery.
 *
 * Returns either a successfully parsed input (status 'ok' | 'repaired') or a
 * recovery outcome ('retry' | 'fatal') carrying the Zod error for the caller to
 * surface back to the model.
 */
export function guardToolInput(
  tool: Tool,
  input: unknown,
  toolUseID: string,
): GuardResult {
  const parsed = tool.inputSchema.safeParse(input)

  if (parsed.success) {
    return {
      status: 'ok',
      parsedInput: parsed,
      disposition: 'auto_repair',
      repairs: [],
      attempt: 0,
      recovery: buildRecord(
        tool.name,
        toolUseID,
        input,
        '',
        null,
        input,
        true,
        'auto_repair',
        0,
      ),
    }
  }

  const issues = parsed.error.issues as unknown as ZodIssueLike[]
  const { attempt, capped } = recordAttempt(toolUseID, tool.name)

  const { repaired, repairs } = applyAutoRepairs(tool.name, input, issues)
  const reParsed = repairs.length > 0 ? tool.inputSchema.safeParse(repaired) : parsed

  if (repairs.length > 0 && reParsed.success) {
    return {
      status: 'repaired',
      parsedInput: reParsed,
      disposition: 'auto_repair',
      repairs,
      attempt,
      recovery: buildRecord(
        tool.name,
        toolUseID,
        input,
        parsed.error.message,
        repairs[0] ?? null,
        repaired,
        true,
        'auto_repair',
        attempt,
      ),
    }
  }

  const disposition: RepairDisposition = capped ? 'fatal' : 'retry'
  return {
    status: disposition === 'fatal' ? 'fatal' : 'retry',
    error: parsed.error,
    issuesMessage: parsed.error.message,
    disposition,
    repairs,
    attempt,
    recovery: buildRecord(
      tool.name,
      toolUseID,
      input,
      parsed.error.message,
      repairs[0] ?? null,
      null,
      false,
      disposition,
      attempt,
    ),
  }
}
