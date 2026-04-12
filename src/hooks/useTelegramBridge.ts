import { useCallback, useEffect, useRef } from 'react'
import type { AppStateStore } from '../state/AppState.js'
import { telegramService } from '../services/telegram/TelegramService.js'
import {
  TELEGRAM_CHANNEL_SERVER,
  type TelegramInboundEvent,
} from '../services/telegram/telegramTypes.js'
import {
  handleTelegramCallback,
  logTelegramInteractiveError,
  maybeHandleTelegramInteractiveInput,
} from '../services/telegram/interactiveCommands.js'
import { hasTelegramRuntimeConfig } from '../services/telegram/telegramConfig.js'
import type { Message } from '../types/message.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { getContentText } from '../utils/messages.js'

// 日志函数 - 已禁用，不再写入文件
function logTelegramDebug(message: string, level: 'debug' | 'error' | 'info' = 'debug'): void {
  // Telegram 功能已完成，禁用日志输出到 log.md
  // 如需调试，可以临时取消注释下面的代码
  /*
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const LOG_FILE_PATH = path.join(process.cwd(), 'log.md')
    const timestamp = new Date().toISOString()
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`
    fs.appendFileSync(LOG_FILE_PATH, logEntry, 'utf-8')
  } catch (error) {
    // 忽略文件写入错误
  }
  */
}

type Props = {
  messages: Message[]
  isLoading: boolean
  store: AppStateStore
}

type ActiveTelegramTurn = {
  chatId: string
  responseParts: string[]
}

const TELEGRAM_TYPING_REFRESH_MS = 4000

function stripXmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim()
}

export function useTelegramBridge({ messages, isLoading, store }: Props): void {
  const pendingInboundRef = useRef<TelegramInboundEvent[]>([])
  const activeTurnRef = useRef<ActiveTelegramTurn | null>(null)
  const lastProcessedMessageCountRef = useRef(messages.length)
  const previousLoadingRef = useRef(isLoading)
  const autoStartAttemptedRef = useRef(false)
  const typingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const typingChatIdRef = useRef<string | null>(null)

  const stopTypingKeepAlive = useCallback(() => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current)
      typingIntervalRef.current = null
    }
    typingChatIdRef.current = null
  }, [])

  const sendTyping = useCallback(
    (chatId: string) => {
      void telegramService.sendChatAction(chatId, 'typing').catch(error => {
        logTelegramDebug(
          `[telegram] failed to send typing action: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'error',
        )
        if (
          error instanceof Error &&
          error.message === 'Telegram service is not running'
        ) {
          stopTypingKeepAlive()
        }
      })
    },
    [stopTypingKeepAlive],
  )

  const startTypingKeepAlive = useCallback(
    (chatId: string) => {
      if (
        typingChatIdRef.current === chatId &&
        typingIntervalRef.current !== null
      ) {
        return
      }

      stopTypingKeepAlive()
      typingChatIdRef.current = chatId
      sendTyping(chatId)
      typingIntervalRef.current = setInterval(() => {
        sendTyping(chatId)
      }, TELEGRAM_TYPING_REFRESH_MS)
    },
    [sendTyping, stopTypingKeepAlive],
  )

  useEffect(() => {
    if (autoStartAttemptedRef.current) return
    autoStartAttemptedRef.current = true
    if (!hasTelegramRuntimeConfig()) return

    void telegramService.startFromSavedConfig().catch(error => {
      logTelegramDebug(`[telegram] auto-start failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }, [])

  useEffect(() => stopTypingKeepAlive, [stopTypingKeepAlive])

  useEffect(() => {
    return telegramService.subscribe(() => {
      if (telegramService.getStateSnapshot().status !== 'running') {
        stopTypingKeepAlive()
      }
    })
  }, [stopTypingKeepAlive])

  useEffect(() => {
    return telegramService.subscribeToInbound(event => {
      void (async () => {
        try {
          logTelegramDebug(`[telegram] received inbound event: chatId=${event.chatId}, text=${event.text.slice(0, 50)}`)

          if (await maybeHandleTelegramInteractiveInput(event, store)) {
            return
          }

          pendingInboundRef.current.push(event)
          logTelegramDebug(`[telegram] added to pendingInboundRef: chatId=${event.chatId}`)

          sendTyping(event.chatId)

          enqueue({
            value: event.text,
            mode: 'prompt',
            skipSlashCommands: true,
            bridgeOrigin: true,
            origin: {
              kind: 'channel',
              server: TELEGRAM_CHANNEL_SERVER,
            } as const,
          })
        } catch (error) {
          logTelegramInteractiveError(error)
          await telegramService.sendMessage(
            event.chatId,
            `Telegram 交互处理失败: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ).catch(() => {})
        }
      })()
    })
  }, [sendTyping, store])

  useEffect(() => {
    return telegramService.subscribeToCallbacks(event => {
      void (async () => {
        try {
          await handleTelegramCallback(event, store)
        } catch (error) {
          logTelegramInteractiveError(error)
          await telegramService.answerCallbackQuery(
            event.callbackQueryId,
            '处理按钮操作失败',
          ).catch(() => {})
          await telegramService.sendMessage(
            event.chatId,
            `Telegram 按钮操作失败: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ).catch(() => {})
        }
      })()
    })
  }, [store])

  useEffect(() => {
    const newMessages = messages.slice(lastProcessedMessageCountRef.current)

    logTelegramDebug(`[telegram] processing ${newMessages.length} new messages, activeTurn: ${activeTurnRef.current ? 'active' : 'null'}`)

    for (const message of newMessages) {
      logTelegramDebug(`[telegram] processing message: type=${message.type}, hasOrigin=!!${message.origin}, origin=${JSON.stringify(message.origin)}`)

      if (
        message.type === 'user' &&
        message.origin?.kind === 'channel' &&
        message.origin.server === TELEGRAM_CHANNEL_SERVER
      ) {
        const inbound = pendingInboundRef.current.shift()
        if (inbound) {
          activeTurnRef.current = {
            chatId: inbound.chatId,
            responseParts: [],
          }
          startTypingKeepAlive(inbound.chatId)
          logTelegramDebug(`[telegram] active turn started for chatId: ${inbound.chatId}`)
        }
        continue
      }

      if (message.type === 'assistant' && activeTurnRef.current) {
        const text = getContentText(message.message.content)
        logTelegramDebug(`[telegram] assistant message, text length: ${text?.length || 0}, content type: ${typeof message.message.content}`)
        if (text) {
          activeTurnRef.current.responseParts.push(text)
          logTelegramDebug(`[telegram] added to responseParts, total parts: ${activeTurnRef.current.responseParts.length}`)
        }
        continue
      }

      if (
        message.type === 'system' &&
        message.subtype === 'local_command' &&
        activeTurnRef.current
      ) {
        const text = stripXmlTags(message.content)
        logTelegramDebug(`[telegram] local_command, text length: ${text?.length || 0}`)
        if (text) {
          activeTurnRef.current.responseParts.push(text)
        }
      }
    }

    lastProcessedMessageCountRef.current = messages.length
  }, [messages, startTypingKeepAlive])

  useEffect(() => {
    const wasLoading = previousLoadingRef.current
    previousLoadingRef.current = isLoading

    logTelegramDebug(`[telegram] loading state changed: wasLoading=${wasLoading}, isLoading=${isLoading}, hasActiveTurn=!!${activeTurnRef.current}`)

    if (!wasLoading || isLoading || !activeTurnRef.current) {
      return
    }

    const completedTurn = activeTurnRef.current
    activeTurnRef.current = null

    void (async () => {
      try {
        await telegramService.sendMessage(
          completedTurn.chatId,
          completedTurn.responseParts.join('\n\n').trim() ||
            '这一轮没有可回传的文本结果，请查看本地终端会话。',
        )
      } catch (error) {
        logTelegramDebug(
          `[telegram] failed to send outbound reply: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'error',
        )
      } finally {
        stopTypingKeepAlive()
      }
    })()
  }, [isLoading, stopTypingKeepAlive])
}
