/**
 * Protocol Registry — Phase 1: declaration only.
 * No runtime behavior, no endpoint auto-wiring, no client changes.
 * This is the source of truth for ProtocolId metadata; ProviderDef still
 * owns the actual protocol binding until later phases.
 */
import type { ProtocolId } from '../types.js'

export interface ProtocolDef {
  id: ProtocolId
  displayName: string
  endpointPath?: string
}

export const ProtocolRegistry = {
  'anthropic-messages': {
    id: 'anthropic-messages',
    displayName: 'Anthropic Messages',
    endpointPath: '/v1/messages',
  },
  'openai-chat': {
    id: 'openai-chat',
    displayName: 'OpenAI Chat Completions',
    endpointPath: '/chat/completions',
  },
  'openai-responses': {
    id: 'openai-responses',
    displayName: 'OpenAI Responses',
    endpointPath: '/responses',
  },
  'openai-compatible-chat': {
    id: 'openai-compatible-chat',
    displayName: 'OpenAI Compatible Chat',
    endpointPath: '/chat/completions',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini GenerateContent',
  },
  'bedrock-converse': {
    id: 'bedrock-converse',
    displayName: 'Bedrock Converse',
  },
} as const satisfies Record<ProtocolId, ProtocolDef>
