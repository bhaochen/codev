/**
 * Route — Phase 4: concrete invocation configuration.
 * Provider ≠ Protocol. Route is the composition of provider, model, protocol, endpoint
 * for one call. ProviderDef remains as legacy default/fallback.
 */
import type { LLMRoute, ProviderId, ProtocolId } from '../types.js'

export type { LLMRoute, ProviderId, ProtocolId }

export type RouteInput = string | { model: string; protocol?: ProtocolId; endpoint?: string }

export function normalizeRouteInput(input: RouteInput): {
  rawModel: string
  overrideProtocol?: ProtocolId
  overrideEndpoint?: string
} {
  if (typeof input === 'string') {
    return { rawModel: input }
  }
  return {
    rawModel: input.model,
    overrideProtocol: input.protocol,
    overrideEndpoint: input.endpoint,
  }
}

/** Build final Route from resolved parts, override takes precedence. */
export function buildRoute(params: {
  provider: ProviderId
  model: string
  protocol: ProtocolId
  endpoint?: string
  overrideProtocol?: ProtocolId
  overrideEndpoint?: string
}): LLMRoute {
  return {
    provider: params.provider,
    model: params.model,
    protocol: params.overrideProtocol ?? params.protocol,
    endpoint: params.overrideEndpoint ?? params.endpoint,
  }
}
