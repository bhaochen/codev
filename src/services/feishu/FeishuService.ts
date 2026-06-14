/**
 * FeishuService — in-process Feishu bot using @larksuiteoapi/node-sdk
 *
 * Uses Lark.WSClient to receive events, enqueues messages to REPL,
 * collects responses via polling AppState, sends back to Feishu.
 */

import * as Lark from '@larksuiteoapi/node-sdk'
import { getFeishuConfig, type FeishuRuntimeConfig } from './feishuConfig.js'
import { logForDebugging } from '../../utils/debug.js'

type FeishuServiceState = {
  status: 'stopped' | 'starting' | 'running' | 'error'
  appId?: string
  lastError?: string
}

type Listener = () => void

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

class FeishuService {
  private listeners = new Set<Listener>()
  private state: FeishuServiceState = { status: 'stopped' }
  private config?: FeishuRuntimeConfig
  private client?: Lark.Client
  private wsClient?: { stop?: () => void }
  private runId = 0

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getStateSnapshot = (): FeishuServiceState => this.state

  async start(config: FeishuRuntimeConfig): Promise<void> {
    if (this.state.status === 'running' &&
        this.config?.appId === config.appId &&
        this.config?.appSecret === config.appSecret) {
      return
    }

    await this.stop()
    const runId = ++this.runId
    this.config = config
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    })

    this.setState({ status: 'starting', appId: config.appId, lastError: undefined })

    try {
      // Verify credentials
      await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })
      if (runId !== this.runId) return

      logForDebugging('[feishu] connected successfully')

      const dispatcher = new Lark.EventDispatcher({
        encryptKey: config.encryptKey,
        verificationToken: config.verificationToken,
      })

      dispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          if (runId !== this.runId) return
          try {
            await this.handleInbound(data)
          } catch (err) {
            logForDebugging(`[feishu] inbound error: ${normalizeError(err)}`)
          }
        },
      } as any)

      // @ts-ignore - WSClient instance type varies
      this.wsClient = new Lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.warn,
      })

      await this.wsClient.start?.({ eventDispatcher: dispatcher })
      if (runId !== this.runId) return

      this.setState({ status: 'running', appId: config.appId })
    } catch (err) {
      if (runId !== this.runId) return
      this.setState({ status: 'error', appId: config.appId, lastError: normalizeError(err) })
      throw err
    }
  }

  async startFromSavedConfig(): Promise<void> {
    const config = getFeishuConfig()
    if (!config.appId || !config.appSecret) {
      throw new Error('飞书 App ID 或 App Secret 未配置。')
    }
    await this.start(config)
  }

  async stop(): Promise<void> {
    this.runId++
    try { this.wsClient?.stop?.() } catch {}
    this.wsClient = undefined
    this.client = undefined
    this.config = undefined
    if (this.state.status !== 'stopped') {
      this.setState({ ...this.state, status: 'stopped' })
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.client) return
    const MAX = 4000
    for (let i = 0; i < text.length; i += MAX) {
      const chunk = text.slice(i, i + MAX)
      await this.client.im.message.create({
        data: {
          receive_id: chatId,
          receive_id_type: 'open_id',
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      }).catch((e) => logForDebugging(`[feishu] send error: ${e}`))
    }
  }

  /** Called from useFeishuBridge with REPL message state */
  onMessagesChange(messages: any[], isLoading: boolean): void {
    // Currently a no-op — responses are handled by the bridge pattern
    // where messages go through enqueue → REPL → AppState → back to Feishu
  }

  private async handleInbound(data: any): Promise<void> {
    // Debug: log what we receive
    console.log('[feishu] raw inbound:', JSON.stringify(data).slice(0, 500))

    const event = data.event as any
    const sender = event?.sender as any
    const message = event?.message as any
    console.log('[feishu] event:', JSON.stringify(event)?.slice(0,200))
    console.log('[feishu] sender:', JSON.stringify(sender)?.slice(0,200))
    console.log('[feishu] message:', JSON.stringify(message)?.slice(0,200))

    const chatId = sender?.sender_id?.open_id
    const userId = sender?.sender_id?.open_id
    let text = ''
    try {
      if (message.content) {
        text = JSON.parse(message.content).text?.trim() ?? ''
      }
    } catch {}

    if (!text || !chatId || !userId) return

    // Check allowed users
    if (this.config?.allowedUsers?.length && !this.config.allowedUsers.includes(userId)) {
      await this.sendText(chatId, '你没有权限使用此飞书机器人。')
      return
    }

    logForDebugging(`[feishu] inbound: ${text.slice(0, 50)}`)
    console.log('[feishu] enqueueing:', text.slice(0, 50))

    // Enqueue to REPL — will be picked up by the command queue
    const { enqueue } = await import('../../utils/messageQueueManager.js')
    enqueue({
      value: text,
      mode: 'prompt',
      skipSlashCommands: true,
      bridgeOrigin: true,
      origin: { kind: 'channel', server: 'feishu' },
    })
    console.log('[feishu] enqueued, queue length now:', (await import('../../utils/messageQueueManager.js')).getCommandQueueSnapshot().length)
  }

  private setState(next: FeishuServiceState): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }
}

export const feishuService = new FeishuService()