/**
 * useFeishuBridge — Feishu inbound/outbound bridge hook.
 *
 * - Auto-starts Feishu service if credentials are saved.
 * - Tracks AI response turns for Feishu-originated messages.
 * - Sends generated responses back to the originating Feishu chat.
 */

import { useEffect, useRef } from 'react'
import { feishuService } from '../services/feishu/FeishuService.js'
import { getFeishuConfig } from '../services/feishu/feishuConfig.js'
import { getContentText } from '../utils/messages.js'
import type { Message } from '../types/message.js'

type Props = {
  messages: Message[]
  isLoading: boolean
}

type ActiveFeishuTurn = {
  chatId: string
  responseParts: string[]
}

const FEISHU_CHANNEL_SERVER = 'feishu'

export function useFeishuBridge({ messages, isLoading }: Props): void {
  const autoStartAttemptedRef = useRef(false)
  const pendingInboundRef = useRef<{ chatId: string }[]>([])
  const activeTurnRef = useRef<ActiveFeishuTurn | null>(null)
  const lastProcessedMessageCountRef = useRef(messages.length)
  const previousLoadingRef = useRef(isLoading)

  // Auto-start if configured
  useEffect(() => {
    if (autoStartAttemptedRef.current) return
    autoStartAttemptedRef.current = true

    const config = getFeishuConfig()
    if (!config.appId || !config.appSecret) return

    void feishuService.startFromSavedConfig().catch(e => {
      console.warn('[feishu] auto-start failed:', e instanceof Error ? e.message : String(e))
    })
  }, [])

  // Subscribe to inbound events (stores chatId for turn tracking)
  useEffect(() => {
    return feishuService.subscribeToInbound(event => {
      pendingInboundRef.current.push({ chatId: event.chatId })
    })
  }, [])

  // Process new messages — detect Feishu-originated user messages and collect
  // assistant responses
  useEffect(() => {
    const newMessages = messages.slice(lastProcessedMessageCountRef.current)

    for (const message of newMessages) {
      if (
        message.type === 'user' &&
        typeof message.origin === 'object' &&
        message.origin !== null &&
        (message.origin as Record<string, unknown>).kind === 'channel' &&
        (message.origin as Record<string, unknown>).server === FEISHU_CHANNEL_SERVER
      ) {
        const inbound = pendingInboundRef.current.shift()
        if (inbound) {
          activeTurnRef.current = {
            chatId: inbound.chatId,
            responseParts: [],
          }
        }
        continue
      }

      if (message.type === 'assistant' && activeTurnRef.current) {
        const text = getContentText(message.message.content)
        if (text) {
          activeTurnRef.current.responseParts.push(text)
        }
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

  // When loading completes, send accumulated response back to Feishu
  useEffect(() => {
    const wasLoading = previousLoadingRef.current
    previousLoadingRef.current = isLoading

    if (!wasLoading || isLoading || !activeTurnRef.current) return

    const completedTurn = activeTurnRef.current
    activeTurnRef.current = null

    void (async () => {
      try {
        const reply =
          completedTurn.responseParts.join('\n\n').trim() ||
          '这一轮没有可回传的文本结果，请查看本地终端会话。'
        await feishuService.sendText(completedTurn.chatId, reply)
      } catch (error) {
        console.warn(
          '[feishu] failed to send outbound reply:',
          error instanceof Error ? error.message : String(error),
        )
      }
    })()
  }, [isLoading])
}
