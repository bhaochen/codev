/**
 * Protocol Registry — Phase 8: runtime source of truth.
 * Metadata + handler unified; clients/index.ts is now a thin facade.
 */
import type { ProtocolId, LLMRoute } from '../types.js'
import type { LLMRequest, LLMStreamEvent } from '../runtime/types.js'
import type { AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'
import { queryOpenAICompatibleChat } from './openaiCompatibleChat.js'

export type ProtocolHandler = (
  route: LLMRoute,
  request: LLMRequest,
) => AsyncGenerator<LLMStreamEvent | AssistantMessage | SystemAPIErrorMessage, void>

export interface ProtocolDef {
  id: ProtocolId
  displayName: string
  endpointPath?: string
  handler?: ProtocolHandler
}

export const ProtocolRegistry: Partial<Record<ProtocolId, ProtocolDef>> = {
  'openai-compatible-chat': {
    id: 'openai-compatible-chat',
    displayName: 'OpenAI-compatible Chat',
    endpointPath: '/chat/completions',
    handler: queryOpenAICompatibleChat,
  },
}

export function getProtocolDef(id: ProtocolId): ProtocolDef | undefined {
  return ProtocolRegistry[id]
}

export function getProtocolHandler(id: ProtocolId): ProtocolHandler | undefined {
  return ProtocolRegistry[id]?.handler
}

export function isProtocolSupported(id: ProtocolId): boolean {
  return !!ProtocolRegistry[id]?.handler
}
