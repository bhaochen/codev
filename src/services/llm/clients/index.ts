import type { LLMRoute } from '../types.js'
import type { Message } from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { Options } from '../../api/claude.js'
import type { StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'
import { queryOpenAIChat } from './openaiChat.js'

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
  'openai-responses': { query: queryOpenAIChat },
  // anthropic-messages 由 claude.ts 保留原生 SDK 路径，不经此注册表，待后续收敛
}

export function getClientForRoute(route: LLMRoute): LLMClient | null {
  return clients[route.protocol] ?? null
}
