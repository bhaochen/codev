/**
 * OpenAI Chat 协议共享客户端 — OpenAI / OpenCode / DeepSeek / Qwen 等凡走 openai-chat 的 Provider 共用。
 * Provider 仅决定 endpoint/model/headers，协议执行在此唯一实现。
 */
import type { LLMRoute } from '../types.js'
import type { Message } from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { Options } from '../../api/claude.js'
import type { StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'

export async function* queryOpenAIChat(
  route: LLMRoute,
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  // OpenCode 与 OpenAI 共用同一 Chat Completions 实现，仅 endpoint/model 不同
  if (route.provider === 'opencode') {
    const { queryModelOpencode } = await import('../../api/opencode/queryModelOpencode.js')
    // 复用 opencode 原生路径，但 route 已解析 model/endpoint，覆盖 options
    const patched = { ...options, model: route.model }
    yield* queryModelOpencode(messages, systemPrompt, tools, signal, patched)
    return
  }
  const { queryModelOpenAI } = await import('../../api/openai/index.js')
  const patched = { ...options, model: route.model }
  yield* queryModelOpenAI(messages, systemPrompt, tools, signal, patched)
}
