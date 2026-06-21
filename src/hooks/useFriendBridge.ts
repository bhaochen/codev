/**
 * useFriendBridge — Friend VRM inbound/outbound bridge hook.
 *
 * Mirror of useFeishuBridge:
 *   - Tracks AI response turns for Friend-originated messages
 *   - Broadcasts generated responses to the VRM display via SSE
 *
 * The frontend receives responses as SSE events from broadcastToVrm().
 * No chatId needed — SSE is a broadcast channel to all connected
 * Tauri display clients.
 */

import { useEffect, useRef } from 'react'
import { friendService } from '../friend/FriendService.js'
import { getContentText } from '../utils/messages.js'
import type { Message } from '../types/message.js'

type Props = {
  messages: Message[]
  isLoading: boolean
}

const FRIEND_CHANNEL_SERVER = 'friend'

type ActiveFriendTurn = {
  responseParts: string[]
  /** True if the last collected assistant message contained a tool_use block.
   *  When true, the turn is not complete — more messages expected. */
  hasToolUse: boolean
}

export function useFriendBridge({ messages, isLoading }: Props): void {
  const pendingInboundRef = useRef<number>(0) // counter, no chatId needed
  const activeTurnRef = useRef<ActiveFriendTurn | null>(null)
  const lastProcessedMessageCountRef = useRef(messages.length)
  const previousLoadingRef = useRef(isLoading)

  // Subscribe to inbound events (increments counter for turn tracking)
  useEffect(() => {
    return friendService.subscribeToInbound(event => {
      pendingInboundRef.current++
    })
  }, [])

  // Process new messages — detect Friend-originated user messages and collect
  // assistant responses
  useEffect(() => {
    const newMessages = messages.slice(lastProcessedMessageCountRef.current)

    for (const message of newMessages) {
      if (
        message.type === 'user' &&
        typeof message.origin === 'object' &&
        message.origin !== null &&
        (message.origin as Record<string, unknown>).kind === 'channel' &&
        (message.origin as Record<string, unknown>).server === FRIEND_CHANNEL_SERVER
      ) {
        // Consume one pending inbound
        if (pendingInboundRef.current > 0) {
          pendingInboundRef.current--
          activeTurnRef.current = {
            responseParts: [],
            hasToolUse: false,
          }
        }
        continue
      }

      if (message.type === 'assistant' && activeTurnRef.current) {
        const content = message.message.content
        const text = getContentText(content)
        if (text) {
          activeTurnRef.current.responseParts.push(text)
        }
        // Check if this message contains tool_use → turn continues
        activeTurnRef.current.hasToolUse = Array.isArray(content) &&
          content.some((b: any) => b.type === 'tool_use')
        continue
      }

      if (
        message.type === 'system' &&
        message.subtype === 'local_command' &&
        activeTurnRef.current
      ) {
        const text = message.content
        if (text) {
          activeTurnRef.current.responseParts.push(text)
        }
      }
    }

    lastProcessedMessageCountRef.current = messages.length
  }, [messages])

  // When loading completes, broadcast accumulated response via SSE
  useEffect(() => {
    const wasLoading = previousLoadingRef.current
    previousLoadingRef.current = isLoading

    if (!wasLoading || isLoading || !activeTurnRef.current) return

    // If the last assistant message had a tool_use, the turn is not complete —
    // more messages are expected after tool results resolve. Wait.
    if (activeTurnRef.current.hasToolUse) return

    const completedTurn = activeTurnRef.current
    activeTurnRef.current = null

    void (async () => {
      try {
        const reply =
          completedTurn.responseParts.join('\n\n').trim()

        if (reply) {
          await friendService.broadcastResponse(reply)
        }
      } catch (error) {
        console.warn(
          '[friend] failed to broadcast reply:',
          error instanceof Error ? error.message : String(error),
        )
      }
    })()
  }, [isLoading])
}
