import type { z } from 'zod/v4'
import {
  AsyncHookJSONOutputSchema,
  HookJSONOutputSchema,
  PermissionUpdateSchema,
  SyncHookJSONOutputSchema,
} from './coreSchemas.js'

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'

export type ExitReason =
  | 'clear'
  | 'resume'
  | 'logout'
  | 'prompt_input_exit'
  | 'other'
  | 'bypass_permissions_disabled'

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged'

export type ModelUsage = {
  costUSD?: number
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  [key: string]: number | undefined
}

export type SDKStatus = 'compacting' | string | null

export type SDKBaseMessage = {
  type: string
  subtype?: string
  uuid?: string
  session_id?: string
  [key: string]: unknown
}

export type SDKAssistantMessage = SDKBaseMessage & {
  type: 'assistant'
  message?: { content?: unknown[] }
}

export type SDKAssistantMessageError = SDKBaseMessage & {
  type: 'assistant_error'
  message?: string
}

export type SDKPartialAssistantMessage = SDKBaseMessage & {
  type: 'assistant_partial'
  delta?: string
}

export type SDKResultMessage = SDKBaseMessage & {
  type: 'result'
  is_error?: boolean
  result?: string
  duration_ms?: number
  total_cost_usd?: number
}

export type SDKStatusMessage = SDKBaseMessage & {
  type: 'status'
  status: SDKStatus
}

export type SDKSystemMessage = SDKBaseMessage & {
  type: 'system'
  content?: string
}

export type SDKCompactBoundaryMessage = SDKSystemMessage & {
  subtype: 'compact_boundary' | 'microcompact_boundary'
}

export type SDKToolProgressMessage = SDKBaseMessage & {
  type: 'tool_progress'
  data?: Record<string, unknown>
}

export type SDKPermissionDenial = SDKBaseMessage & {
  type: 'permission_denial'
  mode?: PermissionMode
  toolName?: string
}

export type SDKRateLimitInfo = {
  remaining?: number
  resetAt?: string
}

export type SDKUserMessage = SDKBaseMessage & {
  type: 'user'
  message?: { content?: unknown }
}

export type SDKUserMessageReplay = SDKUserMessage & {
  isReplay?: boolean
}

export type SDKSessionInfo = {
  sessionId: string
  summary?: string
  cwd?: string
  createdAt?: string
  updatedAt?: string
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'ask'; updatedInput?: Record<string, unknown>; message?: string }

export type HookInput = {
  session_id?: string
  event?: HookEvent
  [key: string]: unknown
}

export type PermissionUpdate = z.infer<ReturnType<typeof PermissionUpdateSchema>>

export type HookJSONOutput = z.infer<ReturnType<typeof HookJSONOutputSchema>>

export type SyncHookJSONOutput = z.infer<ReturnType<typeof SyncHookJSONOutputSchema>>

export type AsyncHookJSONOutput = z.infer<ReturnType<typeof AsyncHookJSONOutputSchema>>

export type SDKMessage =
  | SDKAssistantMessage
  | SDKAssistantMessageError
  | SDKCompactBoundaryMessage
  | SDKPartialAssistantMessage
  | SDKPermissionDenial
  | SDKResultMessage
  | SDKStatusMessage
  | SDKSystemMessage
  | SDKToolProgressMessage
  | SDKUserMessage
  | SDKUserMessageReplay

export type SDKResultSuccess = any
export type ApiKeySource = any
export type NotificationHookInput = any
export type PostToolUseHookInput = any
export type PostToolUseFailureHookInput = any
export type PermissionDeniedHookInput = any
export type PreCompactHookInput = any
export type PostCompactHookInput = any
export type PreToolUseHookInput = any
export type SessionStartHookInput = any
export type SessionEndHookInput = any
export type SetupHookInput = any
export type StopFailureHookInput = any
export type SubagentStartHookInput = any
export type SubagentStopHookInput = any
export type TeammateIdleHookInput = any
export type TaskCreatedHookInput = any
export type TaskCompletedHookInput = any
export type ConfigChangeHookInput = any
export type CwdChangedHookInput = any
export type FileChangedHookInput = any
export type InstructionsLoadedHookInput = any
export type UserPromptSubmitHookInput = any
export type PermissionRequestHookInput = any
export type ElicitationHookInput = any
export type ElicitationResultHookInput = any
