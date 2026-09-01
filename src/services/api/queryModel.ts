/**
 * LLM 调用入口 — 兼容 Facade，薄封装 ModelRuntime。
 * 新代码应直接 import { modelRuntime } from '@/services/llm/runtime'，旧代码 via queryModel 保持兼容。
 */
import type { Message, StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type { Options } from './claude.js'

export async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { modelRuntime } = await import('../llm/runtime/index.js')
  yield* modelRuntime.generate({ model: options.model, messages, systemPrompt, tools, signal, options, thinkingConfig })
}
