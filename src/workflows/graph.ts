import type {
  NormalizedWorkflow,
  WorkflowEdge,
} from './types.js'

/** Thrown when an edge cannot resolve to a next node at runtime. */
export class WorkflowGraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowGraphError'
  }
}

/**
 * Static graph validation. Returns one human-readable error per problem so
 * defineWorkflow can report them all at once.
 */
export function validateGraph(def: NormalizedWorkflow): string[] {
  const errors: string[] = []
  const nodeNames = new Set(Object.keys(def.nodes))

  if (!def.nodes[def.startAt]) {
    errors.push(`startAt refers to unknown node "${def.startAt}"`)
  }

  const seenFrom = new Map<string, number>()
  for (const edge of def.edges) {
    if (!nodeNames.has(edge.from)) {
      errors.push(`edge references unknown source node "${edge.from}"`)
    }
    seenFrom.set(edge.from, (seenFrom.get(edge.from) ?? 0) + 1)
    if ('to' in edge) {
      if (!nodeNames.has(edge.to)) {
        errors.push(`edge from "${edge.from}" references unknown target node "${edge.to}"`)
      }
    } else {
      for (const [key, target] of Object.entries(edge.case)) {
        if (!nodeNames.has(target)) {
          errors.push(
            `switch edge from "${edge.from}" routes case "${key}" to unknown node "${target}"`,
          )
        }
      }
      if (edge.default !== undefined && !nodeNames.has(edge.default)) {
        errors.push(
          `switch edge from "${edge.from}" routes default to unknown node "${edge.default}"`,
        )
      }
    }
  }

  for (const [from, count] of seenFrom) {
    if (count > 1) {
      errors.push(`node "${from}" has ${count} outgoing edges; at most one is allowed`)
    }
  }

  return errors
}

/**
 * The routing key a node output contributes to switch edges: the string
 * itself when primitive, otherwise its `route` or `choice` field.
 */
export function routeKeyOf(output: unknown): string | undefined {
  if (typeof output === 'string') return output
  if (typeof output === 'number' || typeof output === 'boolean') return String(output)
  if (output !== null && typeof output === 'object') {
    const record = output as Record<string, unknown>
    if (typeof record.route === 'string') return record.route
    if (typeof record.choice === 'string') return record.choice
  }
  return undefined
}

function edgeFor(def: NormalizedWorkflow, from: string): WorkflowEdge | undefined {
  return def.edges.find(edge => edge.from === from)
}

/**
 * Resolve the next node after `from` finished with `output`.
 * Returns null when no outgoing edge exists — the run completes there.
 * Throws WorkflowGraphError on unresolvable switches.
 */
export function resolveNext(
  def: NormalizedWorkflow,
  from: string,
  output: unknown,
): string | null {
  const edge = edgeFor(def, from)
  if (!edge) return null

  if ('to' in edge) return edge.to

  const key = routeKeyOf(output)
  if (key !== undefined && edge.case[key] !== undefined) {
    return edge.case[key]
  }
  if (edge.default !== undefined) return edge.default

  throw new WorkflowGraphError(
    `no route from "${from}" for output key ${key === undefined ? '(none)' : `"${key}"`}`,
  )
}
