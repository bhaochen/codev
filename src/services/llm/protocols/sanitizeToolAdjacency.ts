/**
 * Tool-call adjacency sanitizer for strict OpenAI-compatible endpoints.
 *
 * Chat Completions requires every `role: "tool"` message to answer a `tool_call`
 * of the immediately preceding assistant message, in order. DeepSeek (and
 * several gateways) reject the whole request otherwise. Histories trimmed or
 * filtered upstream can violate that: an orphan tool result from a dropped
 * assistant turn, a duplicate tool_call id, or an assistant tool_call that never
 * got a result.
 *
 * The pass is deterministic — the same history always yields the same messages —
 * so it also keeps an already-cached prefix byte-stable across turns.
 */
import type { OpenAIChatMessage, OpenAIChatToolCall } from './openaiChatWire.js'

type PendingToolCalls = {
  assistantIndex: number
  pendingIds: Set<string>
  answeredIds: Set<string>
}

function finalizePendingToolCalls(
  messages: OpenAIChatMessage[],
  pending: PendingToolCalls,
): void {
  const assistant = messages[pending.assistantIndex]
  if (!assistant?.tool_calls?.length) return

  const seen = new Set<string>()
  const keptToolCalls = assistant.tool_calls.filter(call => {
    if (!pending.answeredIds.has(call.id) || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (keptToolCalls.length > 0) {
    assistant.tool_calls = keptToolCalls
  } else {
    delete assistant.tool_calls
    if (assistant.content == null) assistant.content = ''
  }
}

function dedupeToolCalls(message: OpenAIChatMessage): OpenAIChatMessage {
  if (!message.tool_calls?.length) return message

  const seen = new Set<string>()
  const toolCalls: OpenAIChatToolCall[] = message.tool_calls.filter(call => {
    if (!call.id || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (toolCalls.length > 0) {
    return { ...message, tool_calls: toolCalls }
  }

  const next = { ...message }
  delete next.tool_calls
  if (next.content == null) next.content = ''
  return next
}

export function sanitizeToolCallAdjacency(
  messages: OpenAIChatMessage[],
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  let pending: PendingToolCalls | null = null

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id
      if (pending && toolCallId && pending.pendingIds.has(toolCallId)) {
        out.push(message.content == null ? { ...message, content: '' } : message)
        pending.pendingIds.delete(toolCallId)
        pending.answeredIds.add(toolCallId)
        if (pending.pendingIds.size === 0) pending = null
      }
      // Otherwise: a tool result nobody asked for — drop it.
      continue
    }

    if (pending) {
      finalizePendingToolCalls(out, pending)
      pending = null
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const assistant = dedupeToolCalls(message)
      out.push(assistant)

      if (assistant.tool_calls?.length) {
        pending = {
          assistantIndex: out.length - 1,
          pendingIds: new Set(assistant.tool_calls.map(call => call.id)),
          answeredIds: new Set<string>(),
        }
      }
      continue
    }

    out.push(message)
  }

  if (pending) finalizePendingToolCalls(out, pending)
  return out
}
