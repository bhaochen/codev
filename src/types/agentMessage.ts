/**
 * AgentMessage - Provider-agnostic semantic representation for Agent Core
 *
 * This module defines the canonical message types that Agent Core uses internally.
 * These types describe Agent semantics without depending on any Provider-specific
 * wire format (Anthropic, OpenAI, Gemini, etc.).
 *
 * Core Principle: Agent Core MUST NOT depend on any provider-specific message format.
 * Provider-specific semantics are preserved through explicit adapter/metadata
 * escape hatches rather than leaking into AgentMessage.
 */

import type { UUID } from 'crypto'

// ============================================================================
// Content Block Types (Provider-agnostic)
// ============================================================================

/**
 * Provider-specific options attached to an Agent content block.
 *
 * This is the explicit escape hatch for semantics that belong to a concrete
 * wire format (Anthropic `cache_control`/`citations`/`caller`, OpenAI
 * reasoning metadata, ...). Agent Core never interprets these; Provider
 * Adapters read/write them when moving between AgentMessage and a wire format.
 */
export type AgentProviderOptions = Record<string, unknown>

/**
 * Text content block - represents plain text content
 */
export type AgentTextBlock = {
  type: 'text'
  text: string
  providerOptions?: AgentProviderOptions
}

/**
 * Image content block - represents an image
 *
 * Supports both inline base64 data and provider-hosted URLs. URL sources are
 * preserved losslessly so they can round-trip back to the original wire format.
 */
export type AgentImageBlock = {
  type: 'image'
  source:
    | {
        type: 'base64'
        media_type: string
        data: string
      }
    | {
        type: 'url'
        url: string
      }
  providerOptions?: AgentProviderOptions
}

/**
 * Document content block - represents an attached document (e.g. PDF)
 */
export type AgentDocumentBlock = {
  type: 'document'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
  title?: string
  context?: string
  providerOptions?: AgentProviderOptions
}

/**
 * Tool use content block - represents a tool call by the assistant
 */
export type AgentToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  providerOptions?: AgentProviderOptions
}

/**
 * Tool result content block - represents the result of a tool call
 */
export type AgentToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | AgentContentBlock[]
  is_error?: boolean
  providerOptions?: AgentProviderOptions
}

/**
 * Thinking content block - represents assistant's thinking/reasoning
 */
export type AgentThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
  providerOptions?: AgentProviderOptions
}

/**
 * Redacted thinking content block - the encrypted remainder of a thinking
 * block that the provider chose not to expose. Opaque to Agent Core; carried
 * through unchanged so multi-turn requests keep their signatures valid.
 */
export type AgentRedactedThinkingBlock = {
  type: 'redacted_thinking'
  data: string
  providerOptions?: AgentProviderOptions
}

/**
 * Escape hatch for wire-format content blocks that Agent Core does not model
 * semantically (e.g. server tool use/results, MCP blocks, container uploads,
 * connector text). Adapters copy these through verbatim in both directions so
 * nothing is silently dropped when a conversation is replayed to a provider.
 */
export type AgentProviderContentBlock = {
  type: string
  [key: string]: unknown
}

/**
 * Union of all content block types used in Agent messages
 */
export type AgentContentBlock =
  | AgentTextBlock
  | AgentImageBlock
  | AgentDocumentBlock
  | AgentToolUseBlock
  | AgentToolResultBlock
  | AgentThinkingBlock
  | AgentRedactedThinkingBlock
  | AgentProviderContentBlock

// ============================================================================
// Message Types (Provider-agnostic)
// ============================================================================

/**
 * Base message interface with common fields
 */
export type AgentMessageBase = {
  uuid: string
  timestamp: number
}

/**
 * User message - messages from the user or system
 */
export type AgentUserMessage = AgentMessageBase & {
  role: 'user'
  content: AgentContentBlock[]
  isMeta?: boolean
  isVirtual?: boolean
}

/**
 * Assistant message - messages from the AI assistant
 */
export type AgentAssistantMessage = AgentMessageBase & {
  role: 'assistant'
  content: AgentContentBlock[]
  model?: string
  stop_reason?: string
  usage?: AgentUsage
}

/**
 * System message - internal system messages
 */
export type AgentSystemMessage = AgentMessageBase & {
  role: 'system'
  content: AgentContentBlock[]
}

/**
 * Union of all message types
 */
export type AgentMessage = AgentUserMessage | AgentAssistantMessage | AgentSystemMessage

// ============================================================================
// Usage Types (Provider-agnostic)
// ============================================================================

/**
 * Token usage information
 */
export type AgentUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// ============================================================================
// Tool Types (Provider-agnostic)
// ============================================================================

/**
 * Tool definition for the agent
 */
export type AgentToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// ============================================================================
// Stream Event Types (Provider-agnostic)
// ============================================================================

/**
 * Base stream event
 */
export type AgentStreamEventBase = {
  type: string
}

/**
 * Message start event
 */
export type AgentMessageStartEvent = AgentStreamEventBase & {
  type: 'message_start'
  message: AgentAssistantMessage
}

/**
 * Content block start event
 */
export type AgentContentBlockStartEvent = AgentStreamEventBase & {
  type: 'content_block_start'
  content_block: AgentContentBlock
}

/**
 * Content block delta event
 */
export type AgentContentBlockDeltaEvent = AgentStreamEventBase & {
  type: 'content_block_delta'
  delta: unknown
}

/**
 * Content block stop event
 */
export type AgentContentBlockStopEvent = AgentStreamEventBase & {
  type: 'content_block_stop'
}

/**
 * Message delta event
 */
export type AgentMessageDeltaEvent = AgentStreamEventBase & {
  type: 'message_delta'
  usage: AgentUsage
}

/**
 * Message stop event
 */
export type AgentMessageStopEvent = AgentStreamEventBase & {
  type: 'message_stop'
}

/**
 * Union of all stream event types
 */
export type AgentStreamEvent =
  | AgentMessageStartEvent
  | AgentContentBlockStartEvent
  | AgentContentBlockDeltaEvent
  | AgentContentBlockStopEvent
  | AgentMessageDeltaEvent
  | AgentMessageStopEvent

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a text content block
 */
export function createTextBlock(text: string): AgentTextBlock {
  return { type: 'text', text }
}

/**
 * Create an image content block
 */
export function createImageBlock(
  mediaType: string,
  data: string,
): AgentImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  }
}

/**
 * Create a tool use content block
 */
export function createToolUseBlock(
  id: string,
  name: string,
  input: unknown,
): AgentToolUseBlock {
  return { type: 'tool_use', id, name, input }
}

/**
 * Create a tool result content block
 */
export function createToolResultBlock(
  tool_use_id: string,
  content?: string | AgentContentBlock[],
  is_error?: boolean,
): AgentToolResultBlock {
  return { type: 'tool_result', tool_use_id, content, is_error }
}

/**
 * Create a thinking content block
 */
export function createThinkingBlock(
  thinking: string,
  signature?: string,
): AgentThinkingBlock {
  return { type: 'thinking', thinking, signature }
}

/**
 * Create a user message
 */
export function createUserMessage(
  content: AgentContentBlock[],
  uuid: string,
  timestamp: number,
  options?: { isMeta?: boolean; isVirtual?: boolean },
): AgentUserMessage {
  return {
    role: 'user',
    content,
    uuid,
    timestamp,
    isMeta: options?.isMeta,
    isVirtual: options?.isVirtual,
  }
}

/**
 * Create an assistant message
 */
export function createAssistantMessage(
  content: AgentContentBlock[],
  uuid: string,
  timestamp: number,
  options?: { model?: string; stop_reason?: string; usage?: AgentUsage },
): AgentAssistantMessage {
  return {
    role: 'assistant',
    content,
    uuid,
    timestamp,
    model: options?.model,
    stop_reason: options?.stop_reason,
    usage: options?.usage,
  }
}

/**
 * Create a system message
 */
export function createSystemMessage(
  content: AgentContentBlock[],
  uuid: string,
  timestamp: number,
): AgentSystemMessage {
  return { role: 'system', content, uuid, timestamp }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a message is a user message
 */
export function isUserMessage(message: AgentMessage): message is AgentUserMessage {
  return message.role === 'user'
}

/**
 * Check if an assistant message
 */
export function isAssistantMessage(message: AgentMessage): message is AgentAssistantMessage {
  return message.role === 'assistant'
}

/**
 * Check if a message is a system message
 */
export function isSystemMessage(message: AgentMessage): message is AgentSystemMessage {
  return message.role === 'system'
}

/**
 * Check if a content block is a text block
 */
export function isTextBlock(block: AgentContentBlock): block is AgentTextBlock {
  return block.type === 'text'
}

/**
 * Check if a content block is an image block
 */
export function isImageBlock(block: AgentContentBlock): block is AgentImageBlock {
  return block.type === 'image'
}

/**
 * Check if a content block is a tool use block
 */
export function isToolUseBlock(block: AgentContentBlock): block is AgentToolUseBlock {
  return block.type === 'tool_use'
}

/**
 * Check if a content block is a tool result block
 */
export function isToolResultBlock(block: AgentContentBlock): block is AgentToolResultBlock {
  return block.type === 'tool_result'
}

/**
 * Check if a content block is a thinking block
 */
export function isThinkingBlock(block: AgentContentBlock): block is AgentThinkingBlock {
  return block.type === 'thinking'
}

/**
 * Check if a content block is a redacted thinking block
 */
export function isRedactedThinkingBlock(
  block: AgentContentBlock,
): block is AgentRedactedThinkingBlock {
  return block.type === 'redacted_thinking'
}

/**
 * Check if a content block is a document block
 */
export function isDocumentBlock(
  block: AgentContentBlock,
): block is AgentDocumentBlock {
  return block.type === 'document'
}

/**
 * Read a single provider option off a content block, regardless of which
 * specific block type it is.
 */
export function getBlockProviderOption(
  block: AgentContentBlock,
  key: string,
): unknown {
  return (block as { providerOptions?: AgentProviderOptions }).providerOptions?.[key]
}

/**
 * Type guard for unmodeled provider/wire-format blocks passing through the
 * escape hatch.
 */
export function isProviderContentBlock(
  block: AgentContentBlock,
): block is AgentProviderContentBlock {
  return !(
    block.type === 'text' ||
    block.type === 'image' ||
    block.type === 'document' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result' ||
    block.type === 'thinking' ||
    block.type === 'redacted_thinking'
  )
}
