import type { ProviderId } from '../types.js'
import {
  noneStrategy,
  createBearerStrategy,
  type AuthStrategy,
  type Credential,
  credentialToHeaders,
} from './strategies.js'
import type { LLMRoute } from '../types.js'
import { getCustomApiConfig } from '../../../utils/auth.js'

export type { Credential } from './strategies.js'

/** All model inference is sent to 9router, which owns upstream credentials. */
const strategyByProvider: Partial<Record<ProviderId, AuthStrategy>> = {
  custom: createBearerStrategy(
    () => getCustomApiConfig().apiKey,
  ),
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
