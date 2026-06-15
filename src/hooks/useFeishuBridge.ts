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
  const pendingInboundRef = useRef<{ chatId: string }[]>([])
  const activeTurnRef = useRef<ActiveFeishuTurn | null>(null)
  const lastProcessedMessageCountRef = useRef(messages.length)
  const previousLoadingRef = useRef(isLoading)

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
        await feishuService.sendMarkdown(completedTurn.chatId, reply)

        // Also send TTS voice if enabled
        const config = getFeishuConfig()
        if (config.ttsEnabled) {
          const rawText = completedTurn.responseParts.join('\n')

          // Deep-clean text before sending to TTS
          let plainText = rawText
          // 去掉代码块标记 ``` ，但保留里面内容
          plainText = plainText.replace(/```(\w*)\n?([\s\S]*?)```/g, '$2')
          // 去掉行内代码标记 ` ，但保留内容
          plainText = plainText.replace(/`([^`]+)`/g, '$1')
          // 去掉 markdown 语法符号（# * _ ~ > | 等）
          plainText = plainText.replace(/[#*_~>|^=\-\[\]()>|\\]/g, '')
          // 去掉花括号内容
          plainText = plainText.replace(/\{[^}]*\}/g, '')
          // 去掉 emoji
          plainText = plainText.replace(
            /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{FE0F}]/gu,
            '',
          )
          // 合并多个换行/空行为单个换行
          plainText = plainText.replace(/\n{2,}/g, '\n')
          // 去掉行首尾空白
          plainText = plainText.split('\n').map(l => l.trim()).join('\n')
          plainText = plainText.trim()

          if (plainText) {
            await feishuService.sendVoice(completedTurn.chatId, plainText)
          }
        }
      } catch (error) {
        console.warn(
          '[feishu] failed to send outbound reply:',
          error instanceof Error ? error.message : String(error),
        )
      }
    })()
  }, [isLoading])
}
