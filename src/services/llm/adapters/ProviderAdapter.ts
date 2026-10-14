/**
 * Provider Adapter — Per-provider authentication, headers, and connection behavior.
 *
 * Separates provider-specific concerns from protocol wire format:
 * - Route Resolver: selects provider, model, endpoint, protocol
 * - Provider Adapter: auth, URL, headers, timeout, connection behavior
 * - Protocol Wire Adapter: request/response/stream format conversion
 * - Compatibility Policy: model-specific quirks (tool freeze, cache, etc.)
 *
 * Design: Not every provider needs a custom adapter. Generic OpenAI-compatible
 * providers share a default adapter configured via declaration. Only providers
 * with truly special behavior (OpenRouter, NVIDIA, OpenCode) get custom adapters.
 */
import type { ProviderId, LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { Credential } from '../auth/strategies.js'

// ============================================================================
// Provider Adapter Interface
// ============================================================================

export interface ProviderAdapter {
  readonly id: ProviderId

  /**
   * Resolve authentication credential for this provider.
   * Returns a Credential that will be converted to headers.
   */
  resolveAuth(): Credential

  /**
   * Build provider-specific headers beyond Content-Type and Authorization.
   * These are merged with protocol-level headers.
   */
  buildHeaders(route: LLMRoute, request: LLMRequest): Record<string, string>

  /**
   * Determine if this provider supports a specific model capability.
   */
  supportsCapability(capability: ModelCapability, model: string): boolean

  /**
   * Get the maximum output tokens for a model, considering provider limits.
   * Returns undefined to use the default.
   */
  getMaxOutputTokens?(model: string): number | undefined

  /**
   * Transform the request body before sending.
   * Use for provider-specific body modifications (e.g., force stream=true).
   */
  transformRequestBody?(body: Record<string, unknown>, route: LLMRoute, request: LLMRequest): Record<string, unknown>

  /**
   * Classify an error from this provider for retry/fallback decisions.
   */
  classifyError?(error: unknown): ProviderErrorClass

  /**
   * Whether this provider is considered "free" for quota/billing purposes.
   */
  isFreeModel?(model: string): boolean
}

export type ModelCapability =
  | 'streaming'
  | 'tool_use'
  | 'vision'
  | 'reasoning'
  | 'reasoning_details'
  | 'prompt_cache'
  | 'json_mode'

export type ProviderErrorClass =
  | 'rate_limit'
  | 'capacity'
  | 'auth'
  | 'timeout'
  | 'context_overflow'
  | 'invalid_request'
  | 'server_error'
  | 'network'
  | 'unknown'

// ============================================================================
// Default Adapter (for generic OpenAI-compatible providers)
// ============================================================================

export interface DefaultAdapterConfig {
  id: ProviderId
  defaultEndpoint?: string
  getApiKey?: () => string | undefined
  getBaseUrl?: () => string
  freeModels?: string[]
  maxOutputTokens?: (model: string) => number | undefined
}

export class DefaultProviderAdapter implements ProviderAdapter {
  readonly id: ProviderId
  private config: DefaultAdapterConfig

  constructor(config: DefaultAdapterConfig) {
    this.id = config.id
    this.config = config
  }

  resolveAuth(): Credential {
    const key = this.config.getApiKey?.()
    if (key) {
      return { type: 'bearer', token: key }
    }
    return { type: 'none' }
  }

  buildHeaders(_route: LLMRoute, _request: LLMRequest): Record<string, string> {
    return {}
  }

  supportsCapability(capability: ModelCapability, model: string): boolean {
    // Default: support everything except provider-specific features
    switch (capability) {
      case 'reasoning_details':
        return false  // Only OpenRouter supports this
      case 'prompt_cache':
        return false  // Only specific providers
      default:
        return true
    }
  }

  getMaxOutputTokens(model: string): number | undefined {
    return this.config.maxOutputTokens?.(model)
  }

  isFreeModel(model: string): boolean {
    return this.config.freeModels?.includes(model) ?? false
  }
}

// ============================================================================
// Adapter Registry
// ============================================================================

export class ProviderAdapterRegistry {
  private adapters = new Map<ProviderId, ProviderAdapter>()

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(provider: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(provider)
  }

  /**
   * Get or create a default adapter for a provider.
   */
  getOrCreateDefault(provider: ProviderId, config: DefaultAdapterConfig): ProviderAdapter {
    let adapter = this.adapters.get(provider)
    if (!adapter) {
      adapter = new DefaultProviderAdapter(config)
      this.adapters.set(provider, adapter)
    }
    return adapter
  }
}

// Global registry instance
const globalRegistry = new ProviderAdapterRegistry()

export function getProviderAdapterRegistry(): ProviderAdapterRegistry {
  return globalRegistry
}
