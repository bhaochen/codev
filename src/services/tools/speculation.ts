/**
 * Speculative Tool Execution Engine (spec-ptc → codev).
 *
 * Core concepts ported from spec-ptc:
 * - SpecKey: (toolName, argsHash) — unique identifier for a tool call
 * - Speculation: one speculative execution (state machine + result)
 * - SpecStore: FIFO claim/adopt store for dedup
 * - Budget: cap concurrent speculative dispatches
 * - NonSpeculated: opaque proxy that aborts speculation on use
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// SpecKey
// ---------------------------------------------------------------------------

export type SpecKey = {
  toolName: string
  argsHash: string
}

/** Deterministic hash of tool input for dedup. */
export function specKey(toolName: string, input: unknown): SpecKey {
  const raw = JSON.stringify(input ?? {})
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  return { toolName, argsHash: hash }
}

// ---------------------------------------------------------------------------
// Speculation state machine
// ---------------------------------------------------------------------------

export type SpecState = 'pending' | 'running' | 'ready' | 'claimed' | 'evicted' | 'failed'

export type Speculation = {
  key: SpecKey
  state: SpecState
  promise: Promise<unknown>
  result?: unknown
  error?: unknown
  startedAt: number
  resolvedAt?: number
}

// ---------------------------------------------------------------------------
// SpecValue — lazy proxy for speculative results
// ---------------------------------------------------------------------------

export class SpecValue<T = unknown> {
  private _promise: Promise<T>
  private _resolved = false
  private _value?: T
  private _error?: unknown

  constructor(spec: Speculation) {
    this._promise = spec.promise as Promise<T>
    this._promise.then(
      v => { this._value = v; this._resolved = true },
      e => { this._error = e; this._resolved = true },
    )
  }

  /** Force the value, blocking until ready or falling back on failure. */
  async force(): Promise<T> {
    // Wait for resolution if not yet resolved
    if (!this._resolved) {
      try {
        this._value = await this._promise
        this._resolved = true
      } catch (e) {
        this._error = e
        this._resolved = true
      }
    }
    if (this._error !== undefined) throw this._error
    return this._value as T
  }

  get isReady(): boolean {
    return this._resolved
  }
}

// ---------------------------------------------------------------------------
// NonSpeculated — opaque proxy that aborts speculation on use
// ---------------------------------------------------------------------------

export class AbortSpeculationError extends Error {
  constructor(reason: string) {
    super(`speculation aborted: ${reason}`)
    this.name = 'AbortSpeculationError'
  }
}

export class NonSpeculated {
  private _reason: string
  constructor(reason: string) {
    this._reason = reason
  }
  toString(): string { throw new AbortSpeculationError(this._reason) }
  valueOf(): never { throw new AbortSpeculationError(this._reason) }
  toJSON(): never { throw new AbortSpeculationError(this._reason) }
}

// ---------------------------------------------------------------------------
// SpecStore — FIFO claim/adopt/evict
// ---------------------------------------------------------------------------

export class SpecStore {
  /** key → queue of speculations (multiplicity-safe: N identical → N entries) */
  private _store = new Map<string, Speculation[]>()

  /** Register a new speculative execution. */
  dispatch(key: SpecKey, promise: Promise<unknown>): Speculation {
    const id = `${key.toolName}::${key.argsHash}`
    const spec: Speculation = {
      key,
      state: 'pending',
      promise,
      startedAt: Date.now(),
    }
    promise.then(
      result => {
        spec.result = result
        spec.state = 'ready'
        spec.resolvedAt = Date.now()
      },
      error => {
        spec.error = error
        spec.state = 'failed'
        spec.resolvedAt = Date.now()
      },
    )
    const queue = this._store.get(id)
    if (queue) {
      queue.push(spec)
    } else {
      this._store.set(id, [spec])
    }
    // Mark running immediately (dispatched = running)
    spec.state = 'running'
    return spec
  }

  /**
   * Try to claim the next ready result for this key.
   * Returns the SpecValue on hit, null on miss.
   */
  claim(key: SpecKey): SpecValue | null {
    const id = `${key.toolName}::${key.argsHash}`
    const queue = this._store.get(id)
    if (!queue || queue.length === 0) return null
    // FIFO: find first ready speculation
    for (let i = 0; i < queue.length; i++) {
      const spec = queue[i]!
      if (spec.state === 'ready') {
        spec.state = 'claimed'
        queue.splice(i, 1)
        if (queue.length === 0) this._store.delete(id)
        return new SpecValue(spec)
      }
    }
    return null
  }

  /** Evict all pending/running speculations for a key (bet retraction). */
  evict(key: SpecKey): number {
    const id = `${key.toolName}::${key.argsHash}`
    const queue = this._store.get(id)
    if (!queue) return 0
    let evicted = 0
    for (const spec of queue) {
      if (spec.state === 'pending' || spec.state === 'running') {
        spec.state = 'evicted'
        evicted++
      }
    }
    // Clean up
    const remaining = queue.filter(s => s.state !== 'evicted')
    if (remaining.length === 0) {
      this._store.delete(id)
    } else {
      this._store.set(id, remaining)
    }
    return evicted
  }

  /** Number of currently in-flight (pending + running) speculations. */
  get inflightCount(): number {
    let n = 0
    for (const queue of this._store.values()) {
      for (const spec of queue) {
        if (spec.state === 'pending' || spec.state === 'running') n++
      }
    }
    return n
  }

  /** Clear all entries (turn boundary). */
  clear(): void {
    for (const queue of this._store.values()) {
      for (const spec of queue) {
        if (spec.state === 'pending' || spec.state === 'running') {
          spec.state = 'evicted'
        }
      }
    }
    this._store.clear()
  }
}

// ---------------------------------------------------------------------------
// Budget — cap speculative dispatches
// ---------------------------------------------------------------------------

export type SpecBudget = {
  /** Max concurrent in-flight speculative calls. */
  maxInflight: number
  /** Hard cap on total dispatches per turn. */
  maxDispatchesPerTurn: number
}

const DEFAULT_BUDGET: SpecBudget = {
  maxInflight: 5,
  maxDispatchesPerTurn: 20,
}

export class BudgetTracker {
  private _budget: SpecBudget
  private _turnDispatches = 0

  constructor(budget: Partial<SpecBudget> = {}) {
    this._budget = { ...DEFAULT_BUDGET, ...budget }
  }

  /** Check if a new dispatch is allowed. */
  canDispatch(store: SpecStore): boolean {
    if (this._turnDispatches >= this._budget.maxDispatchesPerTurn) return false
    if (store.inflightCount >= this._budget.maxInflight) return false
    return true
  }

  /** Record a dispatch. */
  recordDispatch(): void {
    this._turnDispatches++
  }

  /** Reset per-turn counters. */
  reset(): void {
    this._turnDispatches = 0
  }

  get stats() {
    return {
      budget: this._budget,
      turnDispatches: this._turnDispatches,
    }
  }
}

// ---------------------------------------------------------------------------
// isSpeculatable — check if a tool meets speculation requirements
// ---------------------------------------------------------------------------

export function isSpeculatable(tool: { speculatable?: boolean; pure?: boolean }): boolean {
  return tool.speculatable === true && tool.pure === true
}
