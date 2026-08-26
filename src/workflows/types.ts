/**
 * Workflow core types.
 *
 * A workflow is a graph of named nodes with exactly one entry point. Each
 * node finishes with an output, and edges decide what runs next. Modeled
 * after osolmaz/pi-workflows (acpx-style flows), trimmed to the node set
 * this port needs.
 */

/** Context handed to node callbacks while a run executes. */
export type NodeContext = {
  /** The run input (e.g. `{ task: '...' }` parsed from the slash command). */
  input: Record<string, unknown>
  /** Outputs of completed nodes, keyed by node name. */
  outputs: Record<string, unknown>
}

export type AgentNodeDef = {
  kind: 'agent'
  prompt: (ctx: NodeContext) => string | Promise<string>
  /**
   * Human-readable contract for the shape of the structured output the
   * model must deliver via the `workflow` tool's `submit` action.
   */
  expectedOutput?: string
  maxAttempts?: number
}

export type ComputeNodeDef = {
  kind: 'compute'
  run: (ctx: NodeContext) => unknown | Promise<unknown>
}

export type ShellNodeDef = {
  kind: 'shell'
  /** Shell command to execute; function form may build the command from ctx. */
  exec: string | ((ctx: NodeContext) => string)
  /** Parse raw stdout into the node output. */
  parse?: (stdout: string, ctx: NodeContext) => unknown
  timeoutMs?: number
}

export type NotifyNodeDef = {
  kind: 'notify'
  message: string | ((ctx: NodeContext) => string)
}

export type CheckpointNodeDef = {
  kind: 'checkpoint'
  /** Presented to the human when the run parks here. */
  message: string | ((ctx: NodeContext) => string)
}

export type DecisionNodeDef = {
  kind: 'decision'
  prompt: (ctx: NodeContext) => string | Promise<string>
  choices: readonly string[]
  maxAttempts?: number
}

export type WorkflowNodeDef =
  | AgentNodeDef
  | ComputeNodeDef
  | ShellNodeDef
  | NotifyNodeDef
  | CheckpointNodeDef
  | DecisionNodeDef

/** Unconditional edge. */
export type SimpleEdge = {
  from: string
  to: string
}

/**
 * Switch edge: routes on the previous node's routing key — its raw output
 * when primitive, otherwise a string `route` or `choice` field.
 */
export type SwitchEdge = {
  from: string
  case: Record<string, string>
  default?: string
}

export type WorkflowEdge = SimpleEdge | SwitchEdge

export type WorkflowDefinition = {
  name: string
  description?: string
  startAt: string
  nodes: Record<string, WorkflowNodeDef>
  edges: WorkflowEdge[]
  /**
   * Optional final prompt: after the structured run ends, it is sent as one
   * normal turn so the model can present a human-readable summary.
   */
  presentationPrompt?: string
  /** Safety bound on total node executions per run. Default 100. */
  maxSteps?: number
}

export type NormalizedWorkflow = WorkflowDefinition & {
  maxSteps: number
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export type RunStatus =
  /** A node is executing, or the engine is between nodes ready to advance. */
  | 'running'
  /** User requested pause; holds before the next node starts. */
  | 'paused'
  /** Parked at a checkpoint node; needs an answer to continue. */
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type NodeRunStatus = 'pending' | 'active' | 'done' | 'failed'

export type WorkflowSnapshot = {
  status: RunStatus
  /** Next node to run once the engine is running again. */
  currentNode: string | null
  /** Node currently executing (or awaiting a checkpoint answer). */
  activeNode: string | null
  stepCount: number
  attempts: Record<string, number>
  outputs: Record<string, unknown>
  /** Terminal failure reason. */
  error: string | null
  /** Most recent retryable failure, cleared on the next successful step. */
  lastError: string | null
  input: Record<string, unknown>
}

export type EngineAction =
  | { type: 'execute'; node: string }
  | { type: 'await_result'; node: string }
  | { type: 'stop'; reason: RunStatus }
