/**
 * Usage Tracker — Record per-request token usage, retries, and failures.
 *
 * Three separate concerns:
 * - UsageTracker: actual request recording (tokens, retries, failures)
 * - PricingService: cost estimation from versioned pricing table
 * - QuotaManager: account/endpoint/model limits and availability
 *
 * Concurrency: For codev-controlled budgets, use atomic reserve + settle.
 * For provider quotas, distinguish "local estimate" vs "upstream confirmed".
 */
import type { ProviderId } from '../types.js'

// ============================================================================
// Usage Record
// ============================================================================

export interface UsageRecord {
  requestId: string
  sessionId: string
  provider: ProviderId
  model: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  retryCount: number
  failed: boolean
  errorMessage?: string
  durationMs: number
}

export interface UsageSummary {
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalRetries: number
  totalFailures: number
  totalDurationMs: number
  byProvider: Map<ProviderId, ProviderUsageSummary>
}

export interface ProviderUsageSummary {
  provider: ProviderId
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  failureCount: number
}

// ============================================================================
// Usage Tracker
// ============================================================================

export class UsageTracker {
  private records: UsageRecord[] = []
  private maxRecords = 10000

  record(record: UsageRecord): void {
    this.records.push(record)
    if (this.records.length > this.maxRecords) {
      this.records.shift()
    }
  }

  getRecords(filter?: { provider?: ProviderId; sessionId?: string; since?: number }): UsageRecord[] {
    let result = this.records
    if (filter?.provider) {
      result = result.filter(r => r.provider === filter.provider)
    }
    if (filter?.sessionId) {
      result = result.filter(r => r.sessionId === filter.sessionId)
    }
    if (filter?.since) {
      result = result.filter(r => r.timestamp >= filter.since!)
    }
    return result
  }

  getSummary(): UsageSummary {
    const summary: UsageSummary = {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalRetries: 0,
      totalFailures: 0,
      totalDurationMs: 0,
      byProvider: new Map(),
    }

    for (const record of this.records) {
      summary.totalRequests++
      summary.totalInputTokens += record.inputTokens
      summary.totalOutputTokens += record.outputTokens
      summary.totalCacheReadTokens += record.cacheReadTokens
      summary.totalCacheWriteTokens += record.cacheWriteTokens
      summary.totalRetries += record.retryCount
      summary.totalFailures += record.failed ? 1 : 0
      summary.totalDurationMs += record.durationMs

      let providerSummary = summary.byProvider.get(record.provider)
      if (!providerSummary) {
        providerSummary = {
          provider: record.provider,
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          failureCount: 0,
        }
        summary.byProvider.set(record.provider, providerSummary)
      }
      providerSummary.requestCount++
      providerSummary.inputTokens += record.inputTokens
      providerSummary.outputTokens += record.outputTokens
      providerSummary.cacheReadTokens += record.cacheReadTokens
      providerSummary.cacheWriteTokens += record.cacheWriteTokens
      if (record.failed) providerSummary.failureCount++
    }

    return summary
  }

  clear(): void {
    this.records = []
  }
}

// Global singleton
let instance: UsageTracker | null = null

export function getUsageTracker(): UsageTracker {
  if (!instance) {
    instance = new UsageTracker()
  }
  return instance
}
