import type { ProviderId } from '../types.js'
import { getOpenCodeApiKey } from '../../../utils/auth.js'
import { getOpenAIApiKey } from '../../../utils/auth.js'
import { getNvidiaApiKey } from '../../../utils/auth.js'
import {
  createBearerStrategy,
  noneStrategy,
  type AuthStrategy,
  type Credential,
  credentialToHeaders,
} from './strategies.js'
import type { LLMRoute } from '../types.js'

export type { Credential } from './strategies.js'

const bearerOpenAI = createBearerStrategy(getOpenAIApiKey)
const bearerOpenCode = createBearerStrategy(getOpenCodeApiKey, { fallbackToken: 'public' })
const bearerNvidia = createBearerStrategy(getNvidiaApiKey)

/**
 * Provider → AuthStrategy mapping.
 * Bearer strategy is reused (same `id: 'bearer'`) across openai/opencode/nvidia,
 * proving Provider ≠ Auth strategy; firstParty/bedrock/vertex/foundry/local share none.
 */
const strategyByProvider: Partial<Record<ProviderId, AuthStrategy>> = {
  openai: bearerOpenAI,
  opencode: bearerOpenCode,
  nvidia: bearerNvidia,
  firstParty: noneStrategy,
  bedrock: noneStrategy,
  vertex: noneStrategy,
  foundry: noneStrategy,
  local: noneStrategy,
  anthropic: noneStrategy,
}

export function getAuthStrategy(provider: ProviderId): AuthStrategy {
  return strategyByProvider[provider] ?? noneStrategy
}

export function resolveAuth(provider: ProviderId): Credential {
  return getAuthStrategy(provider).resolve(provider)
}

/** Route-aware resolver — future-proof for Route → Auth without changing Protocol signature. */
export function resolveAuthForRoute(route: LLMRoute): Credential {
  return resolveAuth(route.provider)
}

/** Convenience: Credential → headers, caller merges into HttpRequest. */
export function authHeadersForRoute(route: LLMRoute): Record<string, string> {
  return credentialToHeaders(resolveAuthForRoute(route))
}

/** For diagnostics: strategy id for a given provider/route. */
export function authStrategyId(provider: ProviderId): string {
  return getAuthStrategy(provider).id
}
