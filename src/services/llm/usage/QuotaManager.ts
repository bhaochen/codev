/**
 * Quota Manager — Track provider quotas with atomic reserve + settle.
 *
 * Key distinction:
 * - Local estimate: client-side tracking of known limits
 * - Upstream confirmed: provider-reported usage and rate limits
 *
 * Concurrency safety: Two simultaneous checkQuota() calls must not both
 * succeed if together they would exceed the limit. Use atomic reserve.
 */
import type { ProviderId } from '../types.js'

// ============================================================================
// Quota Types
// ============================================================================

export interface QuotaStatus {
  provider: ProviderId
  model: string
  remaining: number
  limit: number
  resetTime: number
  isEstimate: boolean
}

export interface QuotaReservation {
  id: string
  provider: ProviderId
  model: string
  estimatedTokens: number
  reservedAt: number
}

// ============================================================================
// Quota Manager
// ============================================================================

export class QuotaManager {
  private reservations = new Map<string, QuotaReservation>()
  private usage = new Map<string, { used: number; resetTime: number }>()
  private limits = new Map<string, { limit: number; windowMs: number }>()

  /**
   * Set a quota limit for a provider/model combination.
   */
  setLimit(provider: ProviderId, model: string, limit: number, windowMs: number): void {
    const key = this.key(provider, model)
    this.limits.set(key, { limit, windowMs })
  }

  /**
   * Check if a request can be made without exceeding quota.
   * Returns the current quota status.
   */
  checkQuota(provider: ProviderId, model: string, estimatedTokens: number): QuotaStatus {
    const key = this.key(provider, model)
    const limit = this.limits.get(key)
    const used = this.used.get(key)

    if (!limit) {
      // No limit set — assume unlimited
      return {
        provider,
        model,
        remaining: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
        resetTime: Date.now(),
        isEstimate: true,
      }
    }

    const now = Date.now()
    const currentUsed = used && used.resetTime > now ? used.used : 0
    const remaining = Math.max(0, limit.limit - currentUsed)

    return {
      provider,
      model,
      remaining,
      limit: limit.limit,
      resetTime: used?.resetTime ?? now + limit.windowMs,
      isEstimate: true,
    }
  }

  /**
   * Atomically reserve tokens for an upcoming request.
   * Returns reservation ID if successful, null if quota exceeded.
   */
  reserve(provider: ProviderId, model: string, estimatedTokens: number): QuotaReservation | null {
    const key = this.key(provider, model)
    const limit = this.limits.get(key)
    if (!limit) return { id: this.generateId(), provider, model, estimatedTokens, reservedAt: Date.now() }

    const now = Date.now()
    const used = this.used.get(key)
    const currentUsed = used && used.resetTime > now ? used.used : 0

    if (currentUsed + estimatedTokens > limit.limit) {
      return null  // Would exceed quota
    }

    // Atomic update
    this.used.set(key, {
      used: currentUsed + estimatedTokens,
      resetTime: used?.resetTime ?? now + limit.windowMs,
    })

    const reservation: QuotaReservation = {
      id: this.generateId(),
      provider,
      model,
      estimatedTokens,
      reservedAt: now,
    }
    this.reservations.set(reservation.id, reservation)
    return reservation
  }

  /**
   * Settle a reservation with actual usage.
   * Releases the reservation and records actual token count.
   */
  settle(reservationId: string, actualTokens: number): void {
    const reservation = this.reservations.get(reservationId)
    if (!reservation) return

    const key = this.key(reservation.provider, reservation.model)
    const used = this.used.get(key)
    if (used) {
      // Adjust: remove estimated, add actual
      used.used = Math.max(0, used.used - reservation.estimatedTokens + actualTokens)
    }

    this.reservations.delete(reservationId)
  }

  /**
   * Release a reservation without settling (request failed).
   */
  release(reservationId: string): void {
    const reservation = this.reservations.get(reservationId)
    if (!reservation) return

    const key = this.key(reservation.provider, reservation.model)
    const used = this.used.get(key)
    if (used) {
      used.used = Math.max(0, used.used - reservation.estimatedTokens)
    }

    this.reservations.delete(reservationId)
  }

  /**
   * Update quota from provider-reported values (e.g., rate limit headers).
   */
  updateFromProvider(provider: ProviderId, model: string, remaining: number, resetTime: number): void {
    const key = this.key(provider, model)
    const limit = this.limits.get(key)
    if (limit) {
      this.used.set(key, {
        used: limit.limit - remaining,
        resetTime,
      })
    }
  }

  private key(provider: ProviderId, model: string): string {
    return `${provider}:${model}`
  }

  private generateId(): string {
    return `res-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }
}

// Global singleton
let instance: QuotaManager | null = null

export function getQuotaManager(): QuotaManager {
  if (!instance) {
    instance = new QuotaManager()
  }
  return instance
}
