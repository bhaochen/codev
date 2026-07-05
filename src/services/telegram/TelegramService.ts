import { getTelegramRuntimeConfig } from './telegramConfig.js'
import type {
  TelegramAnswerCallbackQueryResponse,
  TelegramBotCommand,
  TelegramCallbackEvent,
  TelegramChatAction,
  TelegramEditMessageResponse,
  TelegramGetMeResponse,
  TelegramGetUpdatesResponse,
  TelegramInboundEvent,
  TelegramInlineKeyboardMarkup,
  TelegramRuntimeConfig,
  TelegramSendMessageResponse,
  TelegramSendChatActionResponse,
  TelegramSetMyCommandsResponse,
  TelegramServiceState,
  TelegramUpdate,
} from './telegramTypes.js'

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

type Listener = () => void
type InboundListener = (event: TelegramInboundEvent) => void
type CallbackListener = (event: TelegramCallbackEvent) => void

const TELEGRAM_API_BASE = 'https://api.telegram.org'
const MAX_TELEGRAM_MESSAGE_LENGTH = 4000
const POLL_TIMEOUT_SECONDS = 25
const RETRY_DELAY_MS = 3000
const MAX_TELEGRAM_MENU_COMMANDS = 100
const TELEGRAM_COMMAND_NAME_RE = /^[a-z0-9_]{1,32}$/

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeTelegramError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function chunkTelegramMessage(text: string): string[] {
  const normalized = text.trim()
  if (!normalized) return ['模型本轮没有返回可发送的文本结果。']

  const chunks: string[] = []
  for (let i = 0; i < normalized.length; i += MAX_TELEGRAM_MESSAGE_LENGTH) {
    chunks.push(normalized.slice(i, i + MAX_TELEGRAM_MESSAGE_LENGTH))
  }
  return chunks
}

function hasSameConfig(
  left: TelegramRuntimeConfig | undefined,
  right: TelegramRuntimeConfig,
): boolean {
  if (!left) return false
  return (
    left.botToken === right.botToken &&
    left.allowedUserIds.join(',') === right.allowedUserIds.join(',')
  )
}

function normalizeCommandDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim().slice(0, 256)
}

async function getTelegramMenuCommands(): Promise<TelegramBotCommand[]> {
  const { getCommands, getCommandName } = await import('../../commands.js')
  const commands = await getCommands(process.cwd())
  const results: TelegramBotCommand[] = []
  const seen = new Set<string>()

  for (const command of commands) {
    const candidates = [getCommandName(command), ...(command.aliases ?? [])]
    const name = candidates.find(candidate => TELEGRAM_COMMAND_NAME_RE.test(candidate))
    if (!name || seen.has(name)) continue

    results.push({
      command: name,
      description: normalizeCommandDescription(command.description),
    })
    seen.add(name)

    if (results.length >= MAX_TELEGRAM_MENU_COMMANDS) {
      break
    }
  }

  return results
}

class TelegramService {
  private listeners = new Set<Listener>()
  private inboundListeners = new Set<InboundListener>()
  private callbackListeners = new Set<CallbackListener>()
  private state: TelegramServiceState = { status: 'stopped' }
  private config?: TelegramRuntimeConfig
  private abortController: AbortController | null = null
  private runId = 0
  private nextUpdateOffset: number | undefined

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeToInbound = (listener: InboundListener): (() => void) => {
    this.inboundListeners.add(listener)
    return () => {
      this.inboundListeners.delete(listener)
    }
  }

  subscribeToCallbacks = (listener: CallbackListener): (() => void) => {
    this.callbackListeners.add(listener)
    return () => {
      this.callbackListeners.delete(listener)
    }
  }

  getStateSnapshot = (): TelegramServiceState => this.state

  async start(config: TelegramRuntimeConfig): Promise<void> {
    if (this.state.status === 'running' && hasSameConfig(this.config, config)) {
      return
    }

    await this.stop()

    const runId = ++this.runId
    const abortController = new AbortController()
    this.abortController = abortController
    this.config = config
    this.nextUpdateOffset = undefined

    this.setState({
      status: 'starting',
      lastError: undefined,
      botUsername: undefined,
      botDisplayName: undefined,
      startedAt: undefined,
      activeChatId: undefined,
      activeUserId: undefined,
    })

    try {
      const response = await this.callTelegram<TelegramGetMeResponse>(
        config,
        'getMe',
        {},
        abortController.signal,
      )

      if (runId !== this.runId || abortController.signal.aborted) return

      try {
        await this.refreshTelegramMenu(config, abortController.signal)
      } catch (error) {
        if (!abortController.signal.aborted && runId === this.runId) {
          const message = normalizeTelegramError(error)
          logTelegramDebug(`[telegram] failed to refresh menu: ${message}`, 'error')
          this.patchState({ lastError: message })
        }
      }

      if (runId !== this.runId || abortController.signal.aborted) return

      this.setState({
        status: 'running',
        botUsername: response.result?.username,
        botDisplayName: response.result?.first_name,
        startedAt: new Date().toISOString(),
        lastError: undefined,
      })

      logTelegramDebug(
        `[telegram] connected as @${response.result?.username ?? 'unknown'}`,
      )

      void this.pollLoop(runId, config, abortController.signal)
    } catch (error) {
      if (abortController.signal.aborted || runId !== this.runId) return
      const message = normalizeTelegramError(error)
      this.setState({
        status: 'stopped',
        lastError: message,
      })
      throw error
    }
  }

  async startFromSavedConfig(): Promise<void> {
    await this.start(getTelegramRuntimeConfig())
  }

  async restartFromSavedConfig(): Promise<void> {
    await this.startFromSavedConfig()
  }

  async stop(): Promise<void> {
    this.runId++
    this.abortController?.abort()
    this.abortController = null
    this.config = undefined
    this.nextUpdateOffset = undefined

    if (this.state.status !== 'stopped') {
      this.setState({
        ...this.state,
        status: 'stopped',
        startedAt: undefined,
      })
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<number | undefined> {
    if (!this.config) {
      throw new Error('Telegram service is not running')
    }

    // Telegram API 支持 chat_id 为字符串格式（特别是对于超出安全整数范围的 ID）
    // 直接使用字符串格式，避免整数溢出问题
    logTelegramDebug(`[telegram] sendMessage called: chatId=${chatId} (type: ${typeof chatId}), text length=${text.length}`)
    logTelegramDebug(`[telegram] allowedUserIds: ${JSON.stringify(this.config.allowedUserIds)}`)

    let lastMessageId: number | undefined

    for (const chunk of chunkTelegramMessage(text)) {
      logTelegramDebug(`[telegram] sending chunk to chat_id: ${chatId}`)
      const response = await this.callTelegram<TelegramSendMessageResponse>(
        this.config,
        'sendMessage',
        {
          chat_id: chatId,
          text: chunk,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
      )
      lastMessageId = response.result?.message_id
      logTelegramDebug(`[telegram] sendMessage succeeded: messageId=${lastMessageId}`)
    }
    return lastMessageId
  }

  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Telegram service is not running')
    }

    // Telegram API 支持 chat_id 为字符串格式（特别是对于超出安全整数范围的 ID）
    // 直接使用字符串格式，避免整数溢出问题
    await this.callTelegram<TelegramEditMessageResponse>(
      this.config,
      'editMessageText',
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
    )
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Telegram service is not running')
    }

    await this.callTelegram<TelegramAnswerCallbackQueryResponse>(
      this.config,
      'answerCallbackQuery',
      {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      },
    )
  }

  async sendChatAction(
    chatId: string,
    action: TelegramChatAction = 'typing',
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Telegram service is not running')
    }

    await this.callTelegram<TelegramSendChatActionResponse>(
      this.config,
      'sendChatAction',
      {
        chat_id: chatId,
        action,
      },
    )
  }


  private setState(nextState: TelegramServiceState): void {
    this.state = nextState
    for (const listener of this.listeners) {
      listener()
    }
  }

  private patchState(patch: Partial<TelegramServiceState>): void {
    this.setState({
      ...this.state,
      ...patch,
    })
  }

  private emitInbound(event: TelegramInboundEvent): void {
    for (const listener of this.inboundListeners) {
      listener(event)
    }
  }
  
  private emitCallback(event: TelegramCallbackEvent): void {
    for (const listener of this.callbackListeners) {
      listener(event)
    }
  }

  private async pollLoop(
    runId: number,
    config: TelegramRuntimeConfig,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && runId === this.runId) {
      try {
        const response = await this.callTelegram<TelegramGetUpdatesResponse>(
          config,
          'getUpdates',
          {
            offset: this.nextUpdateOffset,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ['message', 'callback_query'],
          },
          signal,
        )

        if (signal.aborted || runId !== this.runId) return

        if (this.state.lastError) {
          this.patchState({ lastError: undefined })
        }

        const updates = response.result ?? []
        logTelegramDebug(`[telegram] received ${updates.length} updates from Telegram`)

        for (const update of updates) {
          logTelegramDebug(`[telegram] processing update: update_id=${update.update_id}`)
          this.handleUpdate(update, config)
        }
      } catch (error) {
        if (signal.aborted || runId !== this.runId) return

        const message = normalizeTelegramError(error)
        logTelegramDebug(`[telegram] polling failed: ${message}`, 'error')
        this.patchState({ lastError: message })
        await sleep(RETRY_DELAY_MS)
      }
    }
  }

  private async refreshTelegramMenu(
    config: TelegramRuntimeConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const commands = await getTelegramMenuCommands()

    await this.callTelegram<TelegramSetMyCommandsResponse>(
      config,
      'setMyCommands',
      {
        commands,
      },
      signal,
    )

    logTelegramDebug(`[telegram] refreshed menu commands: ${commands.length}`)
  }

  private handleUpdate(
    update: TelegramUpdate,
    config: TelegramRuntimeConfig,
  ): void {
    try {
      logTelegramDebug(`[telegram] handleUpdate called, update_id: ${update.update_id}`)
      this.nextUpdateOffset = update.update_id + 1

      const message = update.message
      const callbackQuery = update.callback_query

      logTelegramDebug(`[telegram] update structure: has_message=${!!message}, has_callback=${!!callbackQuery}`)

      if (callbackQuery?.data) {
      const chatId = callbackQuery.message?.chat?.id
      const userId = callbackQuery.from?.id
      const messageId = callbackQuery.message?.message_id
      if (
        chatId !== undefined &&
        userId !== undefined &&
        messageId !== undefined &&
        !callbackQuery.from?.is_bot
      ) {
        if (!config.allowedUserIds.includes(String(userId))) {
          return
        }
        this.emitCallback({
          kind: 'callback-query',
          callbackQueryId: callbackQuery.id,
          chatId: String(chatId),
          userId: String(userId),
          messageId,
          data: callbackQuery.data,
        })
      }
      return
    }

    const chatId = message?.chat?.id
    const userId = message?.from?.id

    logTelegramDebug(`[telegram] message details: chatId=${chatId}, userId=${userId}, is_bot=${message?.from?.is_bot}, chat_type=${message?.chat?.type}`)

    if (!message || chatId === undefined || userId === undefined) {
      logTelegramDebug(`[telegram] message rejected: missing required fields`)
      return
    }
    if (message.from?.is_bot) {
      logTelegramDebug(`[telegram] message rejected: from bot`)
      return
    }
    if (message.chat?.type !== 'private') {
      logTelegramDebug(`[telegram] message rejected: not private chat`)
      return
    }

    const normalizedChatId = String(chatId)
    const normalizedUserId = String(userId)

    logTelegramDebug(`[telegram] user validation: normalizedUserId=${normalizedUserId}, allowedUserIds=${JSON.stringify(config.allowedUserIds)}`)

    if (!config.allowedUserIds.includes(normalizedUserId)) {
      void this.sendMessage(
        normalizedChatId,
        '这个 Telegram user id 尚未被当前 /telegram 配置授权。',
      ).catch(() => {})
      return
    }

    this.patchState({
      activeChatId: normalizedChatId,
      activeUserId: normalizedUserId,
    })

    const text = message.text?.trim()

    logTelegramDebug(`[telegram] inbound message from chatId: ${normalizedChatId}, userId: ${normalizedUserId}, text: ${text?.slice(0, 50)}`)

    if (!text) {
      void this.sendMessage(
        normalizedChatId,
        '当前只支持文本消息，请发送纯文本内容。',
      ).catch(() => {})
      return
    }

    if (text === '/start') {
      void this.sendMessage(
        normalizedChatId,
        'Telegram 已连接到当前 Codev 会话。直接发送文本即可开始远程对话。',
      ).catch(() => {})
      return
    }

    logTelegramDebug(`[telegram] emitting inbound event with chatId: ${normalizedChatId}`)
    this.emitInbound({
      kind: 'inbound-message',
      chatId: normalizedChatId,
      userId: normalizedUserId,
      text,
      messageId: message.message_id,
      updateId: update.update_id,
    })
    } catch (error) {
      logTelegramDebug(`[telegram] handleUpdate error: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  private async callTelegram<T>(
    config: TelegramRuntimeConfig,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    logTelegramDebug(`[telegram] calling API: ${method}`)

    // 创建超时信号（30秒超时）
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => {
      timeoutController.abort()
    }, 30000)

    // 合并外部信号和超时信号
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal

    try {
      const body = JSON.stringify(payload)
      logTelegramDebug(`[telegram] API request body: ${body}`)

      const response = await fetch(
        `${TELEGRAM_API_BASE}/bot${config.botToken}/${method}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body,
          signal: combinedSignal,
        },
      )

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error')
        logTelegramDebug(`[telegram] API error: ${method} failed with HTTP ${response.status}: ${errorText}`, 'error')
        throw new Error(`Telegram API ${method} failed with HTTP ${response.status}: ${errorText}`)
      }

      const json = await response.json() as {
        ok?: boolean
        description?: string
      }

      if (!json.ok) {
        logTelegramDebug(`[telegram] API error: ${method} failed: ${json.description ?? 'unknown error'}`, 'error')
        throw new Error(
          `Telegram API ${method} failed: ${json.description ?? 'unknown error'}`,
        )
      }

      return json as T
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logTelegramDebug(`[telegram] API error: ${method} timed out or was aborted`, 'error')
          throw new Error(`Telegram API ${method} timed out`)
        }
        logTelegramDebug(`[telegram] API error: ${method} failed: ${error.message}`, 'error')
        throw new Error(`Telegram API ${method} failed: ${error.message}`)
      }

      logTelegramDebug(`[telegram] API error: ${method} failed with unknown error`, 'error')
      throw new Error(`Telegram API ${method} failed with unknown error`)
    }
  }
}

export const telegramService = new TelegramService()
