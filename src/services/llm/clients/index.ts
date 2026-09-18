import type { LLMRoute } from '../types.js'
import type { LLMRequest, LLMStreamEvent } from '../runtime/types.js'
import type { AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'
import { getProtocolHandler } from '../protocols/index.js'

export type LLMClient = {
  query(
    route: LLMRoute,
    request: LLMRequest,
  ): AsyncGenerator<LLMStreamEvent | AssistantMessage | SystemAPIErrorMessage, void>
}

/** Thin facade over ProtocolRegistry — single source of truth lives in protocols/index.ts */
const clientCache = new Map<string, LLMClient>()
export function getClientForRoute(route: LLMRoute): LLMClient | null {
  const handler = getProtocolHandler(route.protocol)
  if (!handler) return null
  const cached = clientCache.get(route.protocol)
  if (cached) return cached
  const client: LLMClient = { query: handler }
  clientCache.set(route.protocol, client)
  return client
}
