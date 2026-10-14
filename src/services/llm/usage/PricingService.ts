/**
 * Pricing Service — Versioned pricing table for cost estimation.
 *
 * Prices are estimates unless provider reports actual costs.
 * Pricing data can be updated without code changes.
 */

export interface ModelPricing {
  provider: string
  model: string
  inputPerMillion: number    // USD per 1M input tokens
  outputPerMillion: number   // USD per 1M output tokens
  cacheReadPerMillion: number
  cacheWritePerMillion: number
}

// Default pricing table — can be overridden by remote config
const DEFAULT_PRICING: ModelPricing[] = [
  // OpenCode free models
  { provider: 'opencode', model: 'big-pickle', inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
  { provider: 'opencode', model: 'cat-jam-free', inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
  { provider: 'opencode', model: 'ling-3.1-flash-free', inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
  
  // NVIDIA NIM (free tier)
  { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash', inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
  
  // OpenRouter free models
  { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
]

export class PricingService {
  private pricing: ModelPricing[] = DEFAULT_PRICING

  /**
   * Update pricing table (e.g., from remote config).
   */
  updatePricing(pricing: ModelPricing[]): void {
    this.pricing = pricing
  }

  /**
   * Get pricing for a specific model.
   */
  getPricing(provider: string, model: string): ModelPricing | undefined {
    // Try exact match first, then prefix match
    return this.pricing.find(p => p.provider === provider && p.model === model)
      ?? this.pricing.find(p => p.provider === provider && model.startsWith(p.model))
      ?? this.pricing.find(p => p.provider === provider && p.model.startsWith('*'))
  }

  /**
   * Estimate cost for a request.
   * Returns cost in USD.
   */
  estimateCost(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
    cacheWriteTokens: number = 0,
  ): { estimated: boolean; costUsd: number } {
    const pricing = this.getPricing(provider, model)
    if (!pricing) {
      return { estimated: false, costUsd: 0 }
    }

    const cost =
      (inputTokens / 1_000_000) * pricing.inputPerMillion +
      (outputTokens / 1_000_000) * pricing.outputPerMillion +
      (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion +
      (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion

    return { estimated: true, costUsd: cost }
  }
}

// Global singleton
let instance: PricingService | null = null

export function getPricingService(): PricingService {
  if (!instance) {
    instance = new PricingService()
  }
  return instance
}
