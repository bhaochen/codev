/**
 * Codev store/UI message types.
 *
 * Agent Core keeps messages in two layers:
 *
 * 1. CANONICAL semantic messages come from ./agentMessage.ts — provider-agnostic
 *    `AgentMessage` / `AgentUserMessage` / `AgentAssistantMessage` carrying
 *    `AgentContentBlock[]` content. These are the ONLY message abstractions
 *    Agent Core reasons about (role, content, uuid, timestamp).
 *
 * 2. Codev-specific runtime metadata layers on top in this module:
 *    - `origin` attribution (human / channel / coordinator / task-notification)
 *    - the store's discriminator wrapper (`NormalizedMessage` = `{ type,
 *      message, uuid, timestamp, ... }`) unifying user/assistant/system/
 *      progress/attachment entries for rendering and the transcript
 *    - system/progress/grouped/attachment UI message shapes
 *
 * `Message` / `UserMessage` / `AssistantMessage` are thin derivations of the
 * canonical Agent types — NOT independent definitions. The canonical semantic
 * types live in exactly one place (./agentMessage.ts).
 *
 * Provider wire formats (Anthropic/OpenAI/...) never appear here.
 */

import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentStreamEvent,
  AgentUserMessage,
} from './agentMessage.js'

/**
 * Provenance of a message/command, stamped onto the store entry so the
 * transcript records structurally where the content came from.
 * `undefined` = human (keyboard).
 */
export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'channel'; server: string }
  | { kind: 'coordinator' }
  | { kind: 'task-notification' }

/**
 * Any-role canonical semantic message with codev `origin` attribution.
 * See ./agentMessage.ts for the canonical definition.
 */
export type UserMessageData = Omit<AgentUserMessage, 'uuid' | 'timestamp'> & {
  id?: string
  uuid?: string
  timestamp?: string | number
}

export type AssistantMessageData<C extends AgentContentBlock = AgentContentBlock> = Omit<
  AgentAssistantMessage,
  'uuid' | 'timestamp' | 'content'
> & {
  content: C[]
  id?: string
  uuid?: string
  timestamp?: string | number
}

export type UserMessage = {
  type: 'user'
  message: UserMessageData
  uuid: string
  timestamp: string | number
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  summarizeMetadata?: unknown
  toolUseResult?: { stdout?: string; stderr?: string }
  mcpMeta?: unknown
  imagePasteIds?: string[]
  sourceToolAssistantUUID?: string
  permissionMode?: string
  origin?: MessageOrigin
}

export type AssistantMessage<C extends AgentContentBlock = AgentContentBlock> = {
  type: 'assistant'
  message: AssistantMessageData<C>
  uuid: string
  timestamp: string | number
  model?: string
  requestId?: string
  origin?: MessageOrigin
}

export type NormalizedUserMessage = UserMessage

export type NormalizedAssistantMessage<
  C extends AgentContentBlock = AgentContentBlock,
> = AssistantMessage<C>

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage

export type Message =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage
  | HookResultMessage
  | ToolUseSummaryMessage
  | GroupedToolUseMessage
  | TombstoneMessage

export type SystemMessage = {
  type: 'system'
  subtype: string
  uuid: string
  timestamp: number
  level?: string
  text?: string
}

export type SystemInformationalMessage = SystemMessage & {
  subtype: 'informational'
  text: string
}

export type SystemAPIErrorMessage = SystemMessage & {
  subtype: 'api_error'
  error: string
}

export type StopHookInfo = {
  command: string
  durationMs?: number
  hookName?: string
}

export type SystemStopHookSummaryMessage = SystemMessage & {
  subtype: 'stop_hook_summary'
  hookLabel: string
  hookCount: number
  totalDurationMs?: number
  hookInfos: StopHookInfo[]
}

export type SystemAgentsKilledMessage = SystemMessage & {
  subtype: 'agents_killed'
}

export type SystemApiMetricsMessage = SystemMessage & {
  subtype: 'api_metrics'
}

export type SystemAwaySummaryMessage = SystemMessage & {
  subtype: 'away_summary'
}

export type SystemBridgeStatusMessage = SystemMessage & {
  subtype: 'bridge_status'
}

export type SystemCompactBoundaryMessage = SystemMessage & {
  subtype: 'compact_boundary'
}

export type SystemLocalCommandMessage = SystemMessage & {
  subtype: 'local_command'
}

export type SystemMemorySavedMessage = SystemMessage & {
  subtype: 'memory_saved'
}

export type SystemMicrocompactBoundaryMessage = SystemMessage & {
  subtype: 'microcompact_boundary'
}

export type SystemPermissionRetryMessage = SystemMessage & {
  subtype: 'permission_retry'
}

export type SystemScheduledTaskFireMessage = SystemMessage & {
  subtype: 'scheduled_task_fire'
}

export type SystemTurnDurationMessage = SystemMessage & {
  subtype: 'turn_duration'
}

export type ProgressMessage<P extends { type: string } = {
  type: string
  phase?: string
  toolName?: string
  toolInput?: unknown
  elapsedTimeSeconds?: number
  totalLines?: number
}> = {
  type: 'progress'
  uuid: string
  timestamp: string | number
  toolUseID?: string
  parentToolUseID?: string
  data?: P
}

export type HookResultMessage = {
  type: 'hook_result'
  uuid: string
  timestamp: number
  hookName: string
}

export type Attachment = {
  type: string
  memories?: { path: string; content: string; mtimeMs: number }[]
}

export type AttachmentMessage<T extends Attachment = Attachment> = {
  type: 'attachment'
  attachment: T
  uuid: string
  timestamp: number
}

export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage[]
  uuid: string
  timestamp: number
  displayMessage: NormalizedAssistantMessage
}

export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | GroupedToolUseMessage
  | NormalizedUserMessage

export type RenderableMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | SystemMessage
  | AttachmentMessage
  | GroupedToolUseMessage
  | ProgressMessage

export type TombstoneMessage = SystemMessage & {
  subtype: 'tombstone'
}

export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  uuid: string
  timestamp: number
}

export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: string
  messages: CollapsibleMessage[]
  displayMessage: CollapsibleMessage
  uuid: string
  timestamp: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: { sha: string; kind: string }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: string }[]
  prs?: { number: number; url?: string; action: string }[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  webFetchCount?: number
  webFetchURLs?: string[]
}

export type PartialCompactDirection = 'forward' | 'backward'

export type RequestStartEvent = {
  type: 'request_start'
  timestamp: number
}

/**
 * Streaming event emitted by protocol clients (Anthropic, OpenAI Chat,
 * OpenAI Responses, OpenAI-compatible) and consumed by Agent Core.
 *
 * Provider-agnostic: an alias of `AgentStreamEvent`. The Provider adapter
 * (e.g. Anthropic block/param conversion) translates between this canonical
 * shape and each provider's native stream events at the client boundary.
 */
export type StreamEvent = AgentStreamEvent

export type CompactMetadata = any
export type SystemFileSnapshotMessage = any
export type SystemThinkingMessage = any
