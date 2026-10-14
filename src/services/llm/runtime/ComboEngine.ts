/**
 * ComboEngine — Multi-model cascade with safe streaming fallback.
 *
 * Safety invariant: Once any content event (text, thinking, tool_use) has been
 * emitted to the consumer, we CANNOT transparently switch models. The consumer
 * has already seen partial output that cannot be withdrawn.
 *
 * Fallback rules:
 * - Pre-stream failure (no events emitted) → safe to try next candidate
 * - Post-stream failure (events already emitted) → terminate, do NOT fall back
 * - User cancel → abort entire request, no fallback
 * - Auth errors (401/403) → no fallback (next candidate likely same issue)
 * - Rate limits (429) → respect Retry-After, fallback if within budget
 * - Context overflow → no fallback (next model may have smaller window)
 *
 * Responsibility: Candidate selection + cross-model fallback only.
 * Per-candidate transient retries are handled by the existing withRetry layer.
 * Total attempt budget is shared across all candidates.
 */
import type { ProviderId } from '../types.js'
import type { LLMRequest, LLMStreamEvent } from './types.js'
import { resolveRoute } from '../router/resolveRoute.js'
import { getClientForRoute } from '../clients/index.js'
import { getModelMetadata } from '../models/registry.js'
import { errorMessage } from '../../../utils/errors.js'

// ============================================================================
// Error Classification
// ============================================================================

export type ComboErrorClass =
  | 'pre_stream'        // Failed before any content emitted — safe to fallback
  | 'post_stream'       // Failed after content emitted — CANNOT fallback
  | 'auth'              // 401/403 — fallback unlikely to help
  | 'rate_limit'        // 429 — fallback if within retry budget
  | 'timeout'           // Request timeout — fallback if within budget
  | 'context_overflow'  // Context window exceeded — no fallback
  | 'invalid_request'   // 400 — no fallback (bad request)
  | 'abort'             // User cancelled — no fallback
  | 'unknown'           // Unclassified — conservative: no fallback
  | 'capacity'          // 529/503 — fallback if within budget

export function classifyComboError(error: unknown): ComboErrorClass {
  if (error instanceof Error) {
    const msg = error.message ?? ''
    const name = error.name ?? ''
    
    // Abort detection
    if (name === 'AbortError' || name === 'APIUserAbortError' || msg.includes('abort')) {
      return 'abort'
    }
    
    // Auth errors
    if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') || msg.includes('Forbidden')) {
      return 'auth'
    }
    
    // Rate limit
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many Requests')) {
      return 'rate_limit'
    }
    
    // Timeout
    if (name === 'TimeoutError' || msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      return 'timeout'
    }
    
    // Context overflow
    if (msg.includes('context window') || msg.includes('context limit') || msg.includes('context_length_exceeded')) {
      return 'context_overflow'
    }
    
    // Capacity / overloaded
    if (msg.includes('529') || msg.includes('overloaded') || msg.includes('503') || msg.includes('no capacity')) {
      return 'capacity'
    }
    
    // Invalid request
    if (msg.includes('400') || msg.includes('Bad Request') || msg.includes('invalid')) {
      return 'invalid_request'
    }
  }
  
  // Check for status property on error objects
  const status = (error as { status?: number })?.status
  if (status === 429) return 'rate_limit'
  if (status === 529 || status === 503) return 'capacity'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408) return 'timeout'
  if (status === 400) return 'invalid_request'
  if (status && status >= 500) return 'capacity'
  
  return 'unknown'
}

// ============================================================================
// Combo Configuration
// ============================================================================

export interface ComboItem {
  provider: ProviderId
  model: string
  /** Optional display name for logging */
  label?: string
}

export interface ComboConfig {
  /** Ordered candidate list — tried in sequence until one succeeds */
  items: ComboItem[]
  /** Maximum total attempts across all candidates (default: 3) */
  maxAttempts?: number
  /** Maximum time in ms for the entire combo (default: 120000) */
  maxDurationMs?: number
  /** Whether to allow fallback to paid models (default: false) */
  allowPaidFallback?: boolean
  /** Custom per-item cooldown in ms after failure (default: 0) */
  cooldownMs?: number
}

// ============================================================================
// Combo Engine
// ============================================================================

export interface ComboResult {
  /** The candidate that succeeded */
  succeeded: ComboItem
  /** Number of candidates attempted */
  attempts: number
  /** Total time in ms */
  durationMs: number
  /** Whether any previous candidates failed before success */
  hadFallback: boolean
}

export class ComboEngine {
  private cooldowns = new Map<string, number>()
  private startTime = 0
  private totalAttempts = 0

  /**
   * Execute a request through a combo cascade.
   * 
   * Yields LLMStreamEvent from the first successful candidate.
   * Only falls back to next candidate if NO events have been emitted yet.
   */
  async *generate(
    request: LLMRequest,
    combo: ComboConfig,
    onEvent?: (event: ComboEvent) => void
  ): AsyncGenerator<LLMStreamEvent, ComboResult> {
    this.startTime = Date.now()
    this.totalAttempts = 0

    const maxAttempts = combo.maxAttempts ?? combo.items.length
    const maxDuration = combo.maxDurationMs ?? 120_000
    const items = this.filterComboItems(combo.items, combo.allowPaidFallback ?? false)

    if (items.length === 0) {
      throw new Error('No valid combo items after filtering')
    }

    let lastError: unknown = null
    let hadFallback = false

    for (let i = 0; i < items.length; i++) {
      // Check global budget
      if (this.totalAttempts >= maxAttempts) {
        break
      }
      if (Date.now() - this.startTime > maxDuration) {
        onEvent?.({ type: 'budget_exhausted', elapsed: Date.now() - this.startTime })
        break
      }

      const item = items[i]
      
      // Skip if in cooldown
      const cooldownKey = `${item.provider}:${item.model}`
      const cooldownUntil = this.cooldowns.get(cooldownKey) ?? 0
      if (Date.now() < cooldownUntil) {
        onEvent?.({ type: 'skipped_cooldown', item, cooldownRemaining: cooldownUntil - Date.now() })
        continue
      }

      this.totalAttempts++
      onEvent?.({ type: 'attempt_start', item, attempt: this.totalAttempts })

      // Track whether this candidate has emitted any content
      let emittedContent = false

      try {
        // Resolve route for this candidate
        const route = resolveRoute({
          model: item.model,
          provider: item.provider,
        })

        const modelMeta = getModelMetadata(route.model)
        const client = getClientForRoute(route)
        if (!client) {
          throw new Error(`No client for protocol ${route.protocol}`)
        }

        // Create a modified request with the combo item's provider override
        const candidateRequest: LLMRequest = {
          ...request,
          model: item.model,
          context: {
            ...request.context,
            providerOverride: item.provider,
          },
        }

        // Execute and track first-event boundary
        const stream = client.query(route, candidateRequest)
        for await (const event of stream) {
          // Mark that content has been emitted — after this point, no fallback
          if (this.isContentEvent(event)) {
            emittedContent = true
          }
          yield event
        }

        // Success!
        onEvent?.({ type: 'attempt_success', item, hadFallback })
        return {
          succeeded: item,
          attempts: this.totalAttempts,
          durationMs: Date.now() - this.startTime,
          hadFallback,
        }

      } catch (error) {
        lastError = error
        const errorClass = classifyComboError(error)

        onEvent?.({
          type: 'attempt_failed',
          item,
          error: errorMessage(error),
          errorClass,
          emittedContent,
        })

        // CRITICAL: If content was already emitted, we CANNOT fallback
        if (emittedContent) {
          onEvent?.({ type: 'no_fallback_reason', reason: 'content_already_emitted' })
          throw error
        }

        // Check if error class allows fallback
        if (!this.shouldFallback(errorClass)) {
          onEvent?.({ type: 'no_fallback_reason', reason: `error_class_${errorClass}` })
          throw error
        }

        hadFallback = true

        // Set cooldown for this candidate
        if (combo.cooldownMs && combo.cooldownMs > 0) {
          this.cooldowns.set(cooldownKey, Date.now() + combo.cooldownMs)
        }
      }
    }

    // All candidates exhausted
    throw lastError ?? new Error('All combo items exhausted')
  }

  /**
   * Determine if an event represents "content" that cannot be transparently withdrawn.
   * This includes text, thinking, and tool_use events.
   */
  private isContentEvent(event: LLMStreamEvent): boolean {
    // Content events that the consumer has already seen
    switch (event.type) {
      case 'text':
      case 'thinking':
      case 'tool_use':
      case 'tool_result':
        return true
      case 'message_start':
      case 'content_block_start':
        return true
      default:
        return false
    }
  }

  /**
   * Determine if an error class allows fallback to next candidate.
   */
  private shouldFallback(errorClass: ComboErrorClass): boolean {
    switch (errorClass) {
      case 'pre_stream':
      case 'capacity':
      case 'rate_limit':
      case 'timeout':
        return true
      case 'auth':
      case 'context_overflow':
      case 'invalid_request':
      case 'abort':
      case 'post_stream':
      case 'unknown':
        return false
    }
  }

  /**
   * Filter combo items based on paid fallback policy.
   * If allowPaidFallback is false, remove paid models.
   */
  private filterComboItems(items: ComboItem[], allowPaid: boolean): ComboItem[] {
    if (allowPaid) return items
    
    return items.filter(item => {
      // Only allow known free providers
      const freeProviders: ProviderId[] = ['opencode', 'nvidia']
      return freeProviders.includes(item.provider)
    })
  }

  /**
   * Clear all cooldowns (useful for testing).
   */
  clearCooldowns(): void {
    this.cooldowns.clear()
  }
}

// ============================================================================
// Combo Event Types (for observability)
// ============================================================================

export type ComboEvent =
  | { type: 'attempt_start'; item: ComboItem; attempt: number }
  | { type: 'attempt_success'; item: ComboItem; hadFallback: boolean }
  | { type: 'attempt_failed'; item: ComboItem; error: string; errorClass: ComboErrorClass; emittedContent: boolean }
  | { type: 'no_fallback_reason'; reason: string }
  | { type: 'skipped_cooldown'; item: ComboItem; cooldownRemaining: number }
  | { type: 'budget_exhausted'; elapsed: number }
