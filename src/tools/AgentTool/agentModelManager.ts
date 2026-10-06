/**
 * What a spawned agent actually resolved to.
 *
 * The Agent tool's rendered tag used to show `input.model` — the tier alias the
 * caller asked for. That is not necessarily what runs: an agent pinned to a
 * provider keeps its own model, `inherit` follows the parent, and a provider
 * route may rewrite aliases through its own policy. Showing the request
 * instead of the result is how a subagent could appear to run on one model
 * while really running on another.
 *
 * AgentTool records the resolved pair at spawn; the renderer reads it. The map
 * lives in bootstrap STATE, the same place agent colors live, because tool
 * render functions are synchronous and have no access to app state.
 */

import { getAgentModelMap } from '../../bootstrap/state.js'
import type { APIProvider } from '../../utils/model/providers.js'

export type AgentResolvedModel = {
  model: string
  /** Set only when the agent pinned a provider of its own. */
  provider?: APIProvider
}

export function setAgentResolvedModel(
  agentType: string,
  resolved: AgentResolvedModel | undefined,
): void {
  const map = getAgentModelMap()
  if (!resolved || !resolved.model) {
    map.delete(agentType)
    return
  }
  map.set(agentType, resolved)
}

export function getAgentResolvedModel(
  agentType: string | undefined,
): AgentResolvedModel | undefined {
  if (!agentType) return undefined
  return getAgentModelMap().get(agentType)
}
