/**
 * Protocol Registry — Phase 8: runtime source of truth.
 * Metadata + handler unified; clients/index.ts is now a thin facade.
 */
import type { ProtocolId, LLMRoute } from '../types.js'
import type { LLMRequest, LLMStreamEvent } from '../runtime/types.js'
import type { AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'
import { queryOpenAIChat } from '../clients/openaiChat.js'
import { queryAnthropicMessages } from '../clients/anthropicMessages.js'
import { queryOpenAIResponses } from './openaiResponses.js'
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

export const ProtocolRegistry: Record<ProtocolId, ProtocolDef> = {
  'anthropic-messages': {
    id: 'anthropic-messages',
    displayName: 'Anthropic Messages',
    endpointPath: '/v1/messages',
    handler: queryAnthropicMessages,
  },
  'openai-chat': {
    id: 'openai-chat',
    displayName: 'OpenAI Chat Completions',
    endpointPath: '/chat/completions',
    handler: queryOpenAIChat,
  },
  'openai-responses': {
    id: 'openai-responses',
    displayName: 'OpenAI Responses',
    endpointPath: '/responses',
    handler: queryOpenAIResponses,
  },
  'openai-compatible-chat': {
    id: 'openai-compatible-chat',
    displayName: 'OpenAI Compatible Chat',
    endpointPath: '/chat/completions',
    handler: queryOpenAICompatibleChat,
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini GenerateContent',
  },
  'bedrock-converse': {
    id: 'bedrock-converse',
    displayName: 'Bedrock Converse',
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
