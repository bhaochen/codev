/**
 * Anthropic ↔ AgentMessage Adapter
 *
 * Provides bidirectional conversion between Anthropic SDK message types
 * and Provider-agnostic AgentMessage types.
 *
 * Core Principle: Provider-specific semantics are preserved through
 * providerOptions rather than leaking into AgentMessage.
 */

import type {
  ContentBlockParam,
  TextBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  RedactedThinkingBlockParam,
  MessageParam,
  ThinkingBlockParam,
  CacheControlEphemeral,
} from '@anthropic-ai/sdk/resources/messages.mjs'

import type {
  AgentContentBlock,
  AgentTextBlock,
  AgentImageBlock,
  AgentDocumentBlock,
  AgentToolUseBlock,
  AgentToolResultBlock,
  AgentThinkingBlock,
  AgentRedactedThinkingBlock,
  AgentProviderContentBlock,
  AgentMessage,
  AgentUserMessage,
  AgentAssistantMessage,
  AgentUsage,
  AgentProviderOptions,
} from './agentMessage'

/** Drop entries whose value is `undefined` so providerOptions stays minimal. */
function pickDefined(
  options: Record<string, unknown>,
): AgentProviderOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  )
}

// ============================================================================
// Content Block: Anthropic → Agent
// ============================================================================

/**
 * Convert a single Anthropic ContentBlockParam to AgentContentBlock
 */
export function anthropicBlockToAgent(block: ContentBlockParam): AgentContentBlock {
  switch (block.type) {
    case 'text':
      return anthropicTextBlockToAgent(block)
    case 'image':
      return anthropicImageBlockToAgent(block)
    case 'document':
      return anthropicDocumentBlockToAgent(block)
    case 'tool_use':
      return anthropicToolUseBlockToAgent(block)
    case 'tool_result':
      return anthropicToolResultBlockToAgent(block)
    case 'thinking':
      return anthropicThinkingBlockToAgent(block)
    case 'redacted_thinking':
      return anthropicRedactedThinkingBlockToAgent(block)
    default:
      // Unmodeled wire-format block (server tool use, MCP blocks, container
      // uploads, ...): pass through verbatim via the escape hatch so nothing
      // is dropped when the conversation is replayed to a provider.
      return { ...(block as Record<string, unknown>), type: block.type } as unknown as AgentProviderContentBlock
  }
}

function anthropicTextBlockToAgent(block: TextBlockParam): AgentTextBlock {
  const providerOptions = pickDefined({
    cache_control: block.cache_control,
    citations: block.citations,
  })
  return {
    type: 'text',
    text: block.text,
    // Provider-specific: preserve cache_control and citations in providerOptions
    ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
  }
}

function anthropicImageBlockToAgent(block: ImageBlockParam): AgentImageBlock {
  // Both base64 and URL sources are preserved losslessly.
  return {
    type: 'image',
    source: block.source,
  }
}

function anthropicDocumentBlockToAgent(block: DocumentBlockParam): AgentDocumentBlock {
  return {
    type: 'document',
    source: block.source,
    ...(block.title !== undefined && { title: block.title }),
    ...(block.context !== undefined && { context: block.context }),
    ...(block.cache_control && {
      providerOptions: pickDefined({ cache_control: block.cache_control }),
    }),
  }
}

function anthropicToolUseBlockToAgent(block: ToolUseBlockParam): AgentToolUseBlock {
  const providerOptions = pickDefined({
    cache_control: block.cache_control,
    caller: block.caller,
  })
  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: block.input,
    // Provider-specific: preserve cache_control and caller
    ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
  }
}

function anthropicToolResultBlockToAgent(block: ToolResultBlockParam): AgentToolResultBlock {
  let content: string | AgentContentBlock[] | undefined

  if (typeof block.content === 'string') {
    content = block.content
  } else if (Array.isArray(block.content)) {
    content = block.content.map(anthropicBlockToAgent)
  }

  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content,
    is_error: block.is_error,
    // Provider-specific: preserve cache_control
    ...(block.cache_control && {
      providerOptions: pickDefined({ cache_control: block.cache_control }),
    }),
  }
}

function anthropicThinkingBlockToAgent(block: ThinkingBlockParam): AgentThinkingBlock {
  return {
    type: 'thinking',
    thinking: block.thinking,
    signature: block.signature,
  }
}

function anthropicRedactedThinkingBlockToAgent(
  block: RedactedThinkingBlockParam,
): AgentRedactedThinkingBlock {
  return {
    type: 'redacted_thinking',
    data: block.data,
  }
}

// ============================================================================
// Content Block: Agent → Anthropic
// ============================================================================

/**
 * Convert a single AgentContentBlock to Anthropic ContentBlockParam
 */
export function agentBlockToAnthropic(block: AgentContentBlock): ContentBlockParam {
  switch (block.type) {
    case 'text':
      return agentTextBlockToAnthropic(block)
    case 'image':
      return agentImageBlockToAnthropic(block)
    case 'document':
      return agentDocumentBlockToAnthropic(block)
    case 'tool_use':
      return agentToolUseBlockToAnthropic(block)
    case 'tool_result':
      return agentToolResultBlockToAnthropic(block)
    case 'thinking':
      return agentThinkingBlockToAnthropic(block)
    case 'redacted_thinking':
      return agentRedactedThinkingBlockToAnthropic(block)
    default:
      // Escape-hatch block: pass through verbatim. The Agent Core never
      // modified it, so it is still a valid wire-format block.
      return { ...block } as unknown as ContentBlockParam
  }
}

function agentTextBlockToAnthropic(block: AgentTextBlock): TextBlockParam {
  const providerOpts = block.providerOptions
  return {
    type: 'text',
    text: block.text,
    ...(providerOpts?.cache_control && { cache_control: providerOpts.cache_control as CacheControlEphemeral }),
    ...(providerOpts?.citations && { citations: providerOpts.citations as TextBlockParam['citations'] }),
  }
}

function agentImageBlockToAnthropic(block: AgentImageBlock): ImageBlockParam {
  const providerOpts = block.providerOptions
  return {
    type: 'image',
    source: block.source,
    ...(providerOpts?.cache_control && { cache_control: providerOpts.cache_control as CacheControlEphemeral }),
  }
}

function agentDocumentBlockToAnthropic(block: AgentDocumentBlock): DocumentBlockParam {
  const providerOpts = block.providerOptions
  return {
    type: 'document',
    source: block.source,
    ...(block.title !== undefined && { title: block.title }),
    ...(block.context !== undefined && { context: block.context }),
    ...(providerOpts?.cache_control && { cache_control: providerOpts.cache_control as CacheControlEphemeral }),
  }
}

function agentToolUseBlockToAnthropic(block: AgentToolUseBlock): ToolUseBlockParam {
  const providerOpts = block.providerOptions
  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: block.input,
    ...(providerOpts?.cache_control && { cache_control: providerOpts.cache_control as CacheControlEphemeral }),
    ...(providerOpts?.caller && { caller: providerOpts.caller }),
  }
}

function agentToolResultBlockToAnthropic(block: AgentToolResultBlock): ToolResultBlockParam {
  const providerOpts = block.providerOptions
  let content: ToolResultBlockParam['content']

  if (typeof block.content === 'string') {
    content = block.content
  } else if (Array.isArray(block.content)) {
    content = block.content.map(agentBlockToAnthropic)
  }

  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content,
    is_error: block.is_error,
    ...(providerOpts?.cache_control && { cache_control: providerOpts.cache_control as CacheControlEphemeral }),
  }
}

function agentThinkingBlockToAnthropic(block: AgentThinkingBlock): ThinkingBlockParam {
  return {
    type: 'thinking',
    thinking: block.thinking,
    signature: block.signature,
  }
}

function agentRedactedThinkingBlockToAnthropic(
  block: AgentRedactedThinkingBlock,
): RedactedThinkingBlockParam {
  return {
    type: 'redacted_thinking',
    data: block.data,
  }
}

// ============================================================================
// Message: Anthropic → Agent
// ============================================================================

/**
 * Convert Anthropic MessageParam to AgentMessage
 */
export function anthropicMessageToAgent(
  message: MessageParam,
  uuid: string,
  timestamp: number,
): AgentMessage {
  const content: AgentContentBlock[] = Array.isArray(message.content)
    ? message.content.map(anthropicBlockToAgent)
    : [{ type: 'text', text: message.content }]

  if (message.role === 'user') {
    return {
      role: 'user',
      content,
      uuid,
      timestamp,
    }
  }

  // assistant
  return {
    role: 'assistant',
    content,
    uuid,
    timestamp,
  }
}

// ============================================================================
// Message: Agent → Anthropic
// ============================================================================

/**
 * Convert AgentMessage to Anthropic MessageParam
 */
export function agentMessageToAnthropic(message: AgentMessage): MessageParam {
  return {
    role: message.role as 'user' | 'assistant',
    content: message.content.map(agentBlockToAnthropic),
  }
}

// ============================================================================
// Usage Conversion
// ============================================================================

/**
 * Convert Anthropic Usage to AgentUsage
 */
export function anthropicUsageToAgent(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}): AgentUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  }
}
