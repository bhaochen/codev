/**
 * LLM Service Layer — provider-neutral types for a single model invocation.
 *
 * Agent Core reasons about AgentMessage (Agent semantic layer, see
 * types/agentMessage.ts). The LLM service layer (ModelRuntime → protocol
 * clients) crosses the runtime boundary with the neutral types defined here:
 * they express "what a model call needs" (`LLMRequestConfig`) plus the codev
 * runtime context a client uses (`LLMRuntimeContext`), and carry NO provider
 * SDK types.
 *
 * Provider wire formats belong to the protocol clients:
 *   - Anthropic MessageParam / Options → clients/anthropicMessages.ts
 *   - OpenAI wire types               → clients/openaiChat.ts, protocols/*
 *
 * The protocol clients adapt `LLMRequest` to their own wire boundary. Agents
 * must not reach past this layer into provider SDK types.
 */
import type { AgentId } from '../../../types/ids.js'
import type { Message, StreamEvent } from '../../../types/message.js'
import type {
  QueryChainTracking,
  ToolPermissionContext,
  Tools,
} from '../../../Tool.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { QuerySource } from '../../../constants/querySource.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { Notification } from '../../../context/notifications.js'
import type { EffortValue } from '../../../utils/effort.js'
import type { ThinkingConfig } from '../../../utils/thinking.js'
import type {
  BudgetTracker,
  SpecStore,
} from '../../tools/speculation.js'

/**
 * The service-layer stream type emitted by protocol clients. Alias of the
 * Agent semantic stream event — named here so the LLM boundary reads in
 * service-layer terms instead of Agent-layer terms.
 */
export type LLMStreamEvent = StreamEvent

/**
 * Response format intent — provider-neutral. Expresses what the caller wants
 * back, not how a provider spells it.
 */
export type LLMResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: unknown }

/**
 * Tool-selection intent — provider-neutral. Shape mirrors the value callers
 * already produce; each protocol client maps it to its wire type.
 */
export type LLMToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }

/**
 * Model-call parameters — what a single model call needs, independent of the
 * provider that serves it. Fields whose meaning is only expressible in one
 * provider's wire terms live under `providerOptions` and are read by the
 * protocol client that understands them.
 */
export type LLMRequestConfig = {
  /** Override the model's default maximum output token budget. */
  maxOutputTokens?: number
  /** Sampling temperature. */
  temperature?: number
  /** Stop sequences. */
  stopSequences?: string[]
  /** Thinking / reasoning configuration. */
  thinking?: ThinkingConfig
  /** Which tool the model is steered to pick. */
  toolChoice?: LLMToolChoice
  /** Prompt-cache intent. */
  cache?: { enabled?: boolean; skipWrite?: boolean }
  /** Structured / JSON output intent. */
  responseFormat?: LLMResponseFormat
  /**
   * API-side task budget (output_config.task_budget). Distinct from the
   * tokenBudget.ts +500k auto-continue feature — this one is sent to the API
   * so the model can pace itself. `remaining` is computed by the caller
   * (query.ts decrements across the agentic loop).
   */
  taskBudget?: { total: number; remaining?: number }
  /** Provider-specific escape hatch. Agent Core never interprets these;
   *  the protocol client reads the keys it owns. */
  providerOptions?: Record<string, unknown>
}

/**
 * Codev runtime context a protocol client may use while serving a request —
 * provider-neutral. Function/callback fields are passed through by reference
 * (never cloned), so identity is preserved across the boundary.
 */
export type LLMRuntimeContext = {
  model: string
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  fetchOverride?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>
  agentId?: AgentId
  isNonInteractiveSession: boolean
  querySource: QuerySource
  hasAppendSystemPrompt: boolean
  addNotification?: (notif: Notification) => void
  effortValue?: EffortValue
  fallbackModel?: string
  onStreamingFallback?: () => void
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  fastMode?: boolean
  advisorModel?: string
  /** spec-ptc: speculative store and budget for streaming pre-dispatch. */
  specStore?: SpecStore
  specBudget?: BudgetTracker
}

/**
 * One model invocation at the LLM service layer. `messages` stay in Agent
 * semantic form (AgentMessage[] via the Message wrapper); the wire conversion
 * happens inside the protocol client that serves `model`.
 */
export type LLMRequest = {
  model: string
  messages: Message[]
  systemPrompt: SystemPrompt
  tools: Tools
  signal: AbortSignal
  config: LLMRequestConfig
  context: LLMRuntimeContext
}