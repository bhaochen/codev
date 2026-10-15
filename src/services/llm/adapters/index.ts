/**
 * Provider Adapter Registry — Centralized access to provider-specific adapters.
 */
import { ProviderAdapterRegistry } from './ProviderAdapter.js'
import { OpenCodeAdapter } from './OpenCodeAdapter.js'
import { OpenRouterAdapter } from './OpenRouterAdapter.js'
import { NvidiaAdapter } from './NvidiaAdapter.js'

const registry = new ProviderAdapterRegistry()

// Register built-in adapters
registry.register(new OpenCodeAdapter())
registry.register(new OpenRouterAdapter())
registry.register(new NvidiaAdapter())

export function getAdapter(providerId: string) {
  return registry.get(providerId as any)
}

export function getOpencodeAdapter() {
  return registry.get('opencode') as OpenCodeAdapter | undefined
}

export { ProviderAdapter } from './ProviderAdapter.js'
export { DefaultProviderAdapter } from './ProviderAdapter.js'