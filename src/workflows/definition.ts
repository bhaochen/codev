import { validateGraph } from './graph.js'
import type {
  AgentNodeDef,
  CheckpointNodeDef,
  ComputeNodeDef,
  DecisionNodeDef,
  NodeContext,
  NodeRunStatus,
  NormalizedWorkflow,
  NotifyNodeDef,
  ShellNodeDef,
  WorkflowDefinition,
} from './types.js'

export const DEFAULT_MAX_STEPS = 100
export const DEFAULT_AGENT_MAX_ATTEMPTS = 2

/**
 * Define and validate a workflow. Throws when the graph is malformed so
 * authoring mistakes surface at load time, not mid-run.
 */
export function defineWorkflow(def: WorkflowDefinition): NormalizedWorkflow {
  const normalized: NormalizedWorkflow = {
    ...def,
    maxSteps: def.maxSteps ?? DEFAULT_MAX_STEPS,
  }
  const errors = validateGraph(normalized)
  if (errors.length > 0) {
    throw new Error(
      `Invalid workflow "${def.name}":\n${errors.map(e => `  - ${e}`).join('\n')}`,
    )
  }
  return normalized
}

/** Effective attempt budget for a node. */
export function maxAttemptsFor(node: { kind: string; maxAttempts?: number }): number {
  if (node.maxAttempts !== undefined) return node.maxAttempts
  return node.kind === 'agent' || node.kind === 'decision'
    ? DEFAULT_AGENT_MAX_ATTEMPTS
    : 1
}

// ---------------------------------------------------------------------------
// Node constructors
// ---------------------------------------------------------------------------

export function agent(def: Omit<AgentNodeDef, 'kind'>): AgentNodeDef {
  return { kind: 'agent', ...def }
}

export function compute(def: Omit<ComputeNodeDef, 'kind'>): ComputeNodeDef {
  return { kind: 'compute', ...def }
}

export function shell(def: Omit<ShellNodeDef, 'kind'>): ShellNodeDef {
  return { kind: 'shell', ...def }
}

export function notify(def: Omit<NotifyNodeDef, 'kind'>): NotifyNodeDef {
  return { kind: 'notify', ...def }
}

export function checkpoint(def: Omit<CheckpointNodeDef, 'kind'>): CheckpointNodeDef {
  return { kind: 'checkpoint', ...def }
}

/**
 * Decision helper: an agent step that must answer with one of `choices`.
 * The validated choice string becomes both the node output and the switch
 * routing key, so edges read `{ from: node, case: { yes: ..., no: ... } }`.
 */
export function decision(
  def: Omit<DecisionNodeDef, 'kind' | 'expectedOutput'>,
): DecisionNodeDef {
  return { kind: 'decision', ...def }
}

export type { NodeContext, NodeRunStatus }
