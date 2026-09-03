import type { LLMRoute } from '../types.js'
import type { Message } from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { Options } from './anthropicMessages.js'
import type { StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'
import { queryOpenAIChat } from './openaiChat.js'
import { queryOpenAIResponses } from '../protocols/openaiResponses.js'
import { queryOpenAICompatibleChat } from '../protocols/openaiCompatibleChat.js'
import { queryAnthropicMessages } from './anthropicMessages.js'

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

const clients: Record<string, LLMClient> = {
  'openai-chat': { query: queryOpenAIChat },
  'openai-responses': { query: queryOpenAIResponses },
  'openai-compatible-chat': { query: queryOpenAICompatibleChat },
  'anthropic-messages': { query: queryAnthropicMessages },
}

export function getClientForRoute(route: LLMRoute): LLMClient | null {
  return clients[route.protocol] ?? null
}
