/**
 * Freeze the OpenRouter tool list for prompt-cache stability.
 *
 * OpenRouter's implicit (and, for Gemini, explicit) prefix cache is exact: a
 * request is billed at the cache-hit rate only for the leading bytes that match
 * a request the backend has already seen. The tool array sits in that prefix, so
 * a tool description that churns — an MCP server that reconnects, a dynamic
 * field, a changed ordering — cold-starts the whole conversation.
 *
 * This keeps the tool array byte-stable for a conversation lineage:
 *   - Order: a tool's first-seen position is kept for the life of the snapshot.
 *     A tool that disappears leaves its slot (re-adding it later restores the
 *     original position) so the tools after it never shift.
 *   - Description: frozen from the first request. Availability and the schema
 *     stay authoritative — a tool whose parameters actually change is re-sent
 *     with the new schema (and its new description), and a removed tool is not
 *     sent at all — so behavior can never be silently stale, only cheaper.
 *
 * Keyed by caller (route/model/session/agent); different conversations and
 * subagents never share a snapshot. Capped FIFO so an idle conversation ages
 * out.
 */

import type { OpenAIChatTool } from './openaiChatWire.js'

const SNAPSHOT_LIMIT = 256

type Snapshot = { tools: Map<string, OpenAIChatTool> }

const snapshots = new Map<string, Snapshot>()

function touchSnapshot(key: string): Snapshot | undefined {
  const snapshot = snapshots.get(key)
  if (snapshot) {
    // Most recently used last, so eviction drops idle conversations first.
    snapshots.delete(key)
    snapshots.set(key, snapshot)
  }
  return snapshot
}

function sameParameters(a: OpenAIChatTool, b: OpenAIChatTool): boolean {
  return (
    JSON.stringify(a.function.parameters) ===
    JSON.stringify(b.function.parameters)
  )
}

/**
 * Return `tools` frozen to the snapshot for `key` (creating it on first use):
 * stable order and descriptions, with availability and parameter schemas kept
 * authoritative.
 */
export function freezeOpenRouterTools(
  key: string,
  tools: OpenAIChatTool[],
): OpenAIChatTool[] {
  let snapshot = touchSnapshot(key)
  if (!snapshot) {
    snapshot = { tools: new Map() }
    snapshots.set(key, snapshot)
    if (snapshots.size > SNAPSHOT_LIMIT) {
      const oldest = snapshots.keys().next().value
      if (oldest !== undefined) snapshots.delete(oldest)
    }
  }

  const present = new Set<string>()
  for (const tool of tools) {
    const name = tool.function.name
    present.add(name)
    const saved = snapshot.tools.get(name)
    // Updating an existing key keeps its position in the Map.
    if (!saved || !sameParameters(saved, tool)) {
      snapshot.tools.set(name, structuredClone(tool))
    }
  }

  return [...snapshot.tools.values()]
    .filter(tool => present.has(tool.function.name))
    .map(tool => structuredClone(tool))
}

export function _resetOpenRouterToolFreezeForTest(): void {
  snapshots.clear()
}
