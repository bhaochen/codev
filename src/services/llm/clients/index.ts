import type { LLMRoute } from '../types.js'
import type { Message } from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { Options } from './anthropicMessages.js'
import type { StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'
import { getProtocolHandler } from '../protocols/index.js'

export type LLMClient = {
  query(
    route: LLMRoute,
    messages: Message[],
    systemPrompt: SystemPrompt,
    tools: Tools,
    signal: AbortSignal,
    options: Options,
  ): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>
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
