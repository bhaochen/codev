/**
 * FeishuService — in-process Feishu bot using @larksuite/channel
 * Refactored to use vendor modules from lark-coding-agent-bridge.
 */

import * as path from 'node:path'
import * as os from 'node:os'
import {
  createLarkChannel,
  type LarkChannel,
  type NormalizedMessage,
  registerApp,
} from '@larksuite/channel'
import {
  getFeishuConfig,
  saveFeishuConfig,
  type FeishuRuntimeConfig,
} from './feishuConfig.js'

// Vendor modules (from lark-coding-agent-bridge)
import { log } from './vendor/core/logger.js'
import { PendingQueue } from './vendor/bot/pending-queue.js'
import { startKeepalive } from './vendor/bot/keepalive.js'

import { ChatModeCache } from './vendor/bot/chat-mode-cache.js'
import { createOwnerRefreshController } from './vendor/policy/owner.js'
import { fetchQuotedContext, renderQuotedBlock } from './vendor/bot/quote.js'

// ──────────────────────────────────────────────
// Minimal RuntimeControls interface (matches vendor/policy/access.ts)
// ──────────────────────────────────────────────

interface RuntimeControls {
  botOwnerId?: string
  ownerRefreshState: 'ok' | 'failed' | 'unknown'
  ownerRefreshedAt?: number
  ownerRefreshError?: string
}

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

type FeishuServiceState = {
  status: 'stopped' | 'starting' | 'running' | 'error'
  appId?: string
  botName?: string
  ownerId?: string
  lastError?: string
}

type Listener = () => void

/** Inbound event for bridge hook consumption */
type FeishuInboundEvent = {
  chatId: string
  text: string
  senderId: string
}

type InboundListener = (event: FeishuInboundEvent) => void

type AccessDecision = {
  ok: boolean
  reason: string
}

// Minimal RuntimeControls implementation for owner refresh
class FeishuRuntimeControls implements RuntimeControls {
  botOwnerId?: string
  ownerRefreshState: 'ok' | 'failed' | 'unknown' = 'unknown'
  ownerRefreshedAt?: number
  ownerRefreshError?: string
}

// ──────────────────────────────────────────────
// Access control helpers
// ──────────────────────────────────────────────

function isOwner(controls: FeishuRuntimeControls, senderId: string): boolean {
  if (controls.ownerRefreshState === 'unknown') return false
  return Boolean(controls.botOwnerId) && controls.botOwnerId === senderId
}

function canUseDm(
  config: FeishuRuntimeConfig,
  controls: FeishuRuntimeControls,
  senderId: string,
): AccessDecision {
  if (isOwner(controls, senderId)) return { ok: true, reason: 'owner' }
  if (config.admins?.includes(senderId)) return { ok: true, reason: 'admin' }
  if (!config.allowedUsers || config.allowedUsers.length === 0) {
    return { ok: true, reason: 'open-dm' }
  }
  if (config.allowedUsers.includes(senderId)) return { ok: true, reason: 'allowed-user' }
  return { ok: false, reason: 'denied-user' }
}

function canUseGroup(
  config: FeishuRuntimeConfig,
  controls: FeishuRuntimeControls,
  chatId: string,
  senderId: string,
): AccessDecision {
  if (isOwner(controls, senderId)) return { ok: true, reason: 'owner' }
  if (config.admins?.includes(senderId)) return { ok: true, reason: 'admin' }
  if (config.allowedChats?.includes(chatId)) return { ok: true, reason: 'allowed-chat' }
  return { ok: false, reason: 'denied-chat' }
}

function canRunAdminCommand(
  config: FeishuRuntimeConfig,
  controls: FeishuRuntimeControls,
  senderId: string,
): AccessDecision {
  if (isOwner(controls, senderId)) return { ok: true, reason: 'owner' }
  if (config.admins?.includes(senderId)) return { ok: true, reason: 'admin' }
  return { ok: false, reason: 'denied-admin' }
}

// ──────────────────────────────────────────────
// Slash command handler type
// ──────────────────────────────────────────────

type CommandHandler = (
  args: string,
  chatId: string,
  senderId: string,
  channel: LarkChannel,
) => Promise<boolean>

// ──────────────────────────────────────────────
// Main service
// ──────────────────────────────────────────────

class FeishuService {
  private listeners = new Set<Listener>()
  private inboundListeners = new Set<InboundListener>()
  private state: FeishuServiceState = { status: 'stopped' }
  private config?: FeishuRuntimeConfig
  private channel?: LarkChannel
  private pending?: PendingQueue
  private keepalive?: { stop(): void }
  private ownerRefresh?: { start(): Promise<void>; stop(): void }
  private chatModeCache?: ChatModeCache
  private controls = new FeishuRuntimeControls()
  private runId = 0
  private commandHandlers = new Map<string, CommandHandler>()

  constructor() {
    this.registerDefaultCommands()
  }

  // ── Default slash commands ──────────────────

  private registerDefaultCommands(): void {
    this.commandHandlers.set('/stop', async (_args, chatId, _senderId, channel) => {
      await channel.send(chatId, { text: '⏹ 停止命令已收到。' })
      return true
    })

    this.commandHandlers.set('/reset', async (_args, chatId, _senderId, channel) => {
      await channel.send(chatId, { text: '🔄 已重置会话。' })
      return true
    })

    this.commandHandlers.set(
      '/status',
      async (_args, chatId, _senderId, channel) => {
        const cfg = this.config
        const lines = [
          `状态: ${this.state.status}`,
          `App ID: ${cfg?.appId ?? '未配置'}`,
          `Bot: ${this.state.botName ?? '未知'}`,
          `Owner: ${this.controls.botOwnerId ?? '未知'}`,
          `DM 策略: ${
            !cfg?.allowedUsers || cfg.allowedUsers.length === 0
              ? '所有人'
              : '白名单'
          }`,
          `群聊策略: ${
            cfg?.requireMentionInGroup !== false ? '需 @bot' : '所有消息'
          }`,
          `配置群白名单: ${cfg?.allowedChats?.length ?? 0} 个`,
        ]
        await channel.send(chatId, { text: lines.join('\n') })
        return true
      },
    )

    this.commandHandlers.set('/help', async (_args, chatId, _senderId, channel) => {
      const help = [
        '飞书 Bot 命令:',
        '/stop — 中断当前任务',
        '/reset — 重置会话',
        '/status — 查看状态',
        '/help — 显示此帮助',
      ]
      await channel.send(chatId, { text: help.join('\n') })
      return true
    })
  }

  // ── React sync external store interface ─────

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeToInbound = (listener: InboundListener): (() => void) => {
    this.inboundListeners.add(listener)
    return () => this.inboundListeners.delete(listener)
  }

  getStateSnapshot = (): FeishuServiceState => this.state

  // ── Lifecycle ───────────────────────────────

  async start(config: FeishuRuntimeConfig): Promise<void> {
    if (
      this.state.status === 'running' &&
      this.config?.appId === config.appId
    ) {
      return
    }

    await this.stop()
    const runId = ++this.runId
    this.config = config

    this.setState({
      status: 'starting',
      appId: config.appId,
      lastError: undefined,
    })

    try {
      const domain =
        config.tenant === 'lark'
          ? 'https://open.larksuite.com'
          : 'https://open.feishu.cn'

      const channel = createLarkChannel({
        appId: config.appId!,
        appSecret: config.appSecret!,
        domain,
        source: 'versperclaw',
        // Use default logger level (info)
        respectProxyEnv: true,
        wsConfig: { pingTimeout: 3 },
        handshakeTimeoutMs: 8000,
        httpTimeoutMs: 30000,
        policy: {
          dmMode: 'open',
          requireMention: false,
          respondToMentionAll: false,
        },
        safety: { chatQueue: { enabled: false } },
        includeRawEvent: true,
      })

      const chatModeCache = new ChatModeCache()
      const cfg = config // local ref for closure

      // Pending queue with block/unblock support
      const pending = new PendingQueue(600, async (scope, batch) => {
        const first = batch[0]
        if (!first) return

        const chatId = first.chatId
        const senderId = first.senderId
        const text = batch.map(m => m.content).join('\n---\n')

        log.info('flush', 'start', { scope, batchSize: batch.length })

        try {
          const mode = await chatModeCache.resolve(channel, chatId)
          const isGroup = mode !== 'p2p'

          // Access check
          if (isGroup) {
            const access = canUseGroup(cfg, this.controls, chatId, senderId)
            if (!access.ok) {
              if (first.mentionedBot) {
                await channel.send(chatId, {
                  text: '当前群未加入响应列表。请联系 Bot owner 或管理员使用 /invite group 加入白名单。',
                })
              }
              log.info('intake', 'denied-group', {
                chatId,
                senderId,
                reason: access.reason,
              })
              return
            }
            // @mention policy — default requires mention in groups
            if (cfg.requireMentionInGroup !== false && !first.mentionedBot) {
              log.info('intake', 'skip-no-mention', { chatId })
              return
            }
          } else {
            const access = canUseDm(cfg, this.controls, senderId)
            if (!access.ok) {
              log.info('intake', 'denied-dm', {
                chatId,
                senderId,
                reason: access.reason,
              })
              return
            }
          }

          // Slash command routing
          if (text.startsWith('/')) {
            const parts = text.split(/\s+/)
            const cmdName = parts[0] ?? ''
            const args = parts.slice(1).join(' ')
            const handler = this.commandHandlers.get(cmdName)
            if (handler) {
              await handler(args, chatId, senderId, channel)
              return // handled locally
            }
            // Unknown command — let it pass through to the agent
          }

          // Build prompt with optional quoted context
          let fullText = text
          const replyToId = first.replyToMessageId
          if (replyToId) {
            const quote = await fetchQuotedContext(channel, replyToId)
            if (quote) {
              const quotedBlock = renderQuotedBlock([quote])
              if (quotedBlock) {
                fullText = `${quotedBlock}\n\n${text}`
              }
            }
          }

          // Notify inbound listeners (bridge hook uses this for chatId tracking)
          for (const listener of this.inboundListeners) {
            listener({ chatId, text: fullText, senderId })
          }

          // Enqueue to REPL
          const { enqueue } = await import(
            '../../utils/messageQueueManager.js'
          )
          enqueue({
            value: fullText,
            mode: 'prompt',
            skipSlashCommands: true,
            bridgeOrigin: true,
            origin: { kind: 'channel', server: 'feishu' },
          })
        } finally {
          log.info('flush', 'end')
        }
      })

      channel.on({
        message: async (msg: NormalizedMessage) => {
          if (runId !== this.runId) return
          try {
            pending.push(msg.chatId, msg)
          } catch (err) {
            log.fail('intake', err, {
              chatId: msg.chatId,
              msgId: msg.messageId,
            })
          }
        },
        error: (err: unknown) => {
          log.warn('ws', 'error', { err: String(err) })
        },
        reconnecting: () => {
          log.warn('ws', 'reconnecting')
        },
        reconnected: () => {
          log.info('ws', 'reconnected')
        },
      })

      await channel.connect()
      if (runId !== this.runId) return

      this.channel = channel
      this.pending = pending
      this.chatModeCache = chatModeCache

      // Keepalive — defense-in-depth against silent WS issues
      this.keepalive = startKeepalive({
        channel,
        domain,
        forceReconnect: async () => {
          log.info('keepalive', 'reconnect-requested')
          await channel.disconnect()
          await channel.connect()
        },
      })

      // Owner refresh — periodically fetches app owner from Feishu API
      this.ownerRefresh = createOwnerRefreshController({
        controls: this.controls,
        source: channel,
        appId: config.appId ?? '(unknown)',
      })
      await this.ownerRefresh.start()

      const botName = channel.botIdentity?.name ?? config.appId
      log.info('ws', 'connected', {
        bot: botName,
        openId: channel.botIdentity?.openId,
        appId: config.appId,
      })
      this.setState({
        status: 'running',
        appId: config.appId,
        botName,
        ownerId: this.controls.botOwnerId,
      })
    } catch (err) {
      if (runId !== this.runId) return
      const msg = err instanceof Error ? err.message : String(err)
      log.fail('start', err, { appId: config.appId })
      this.setState({ status: 'error', appId: config.appId, lastError: msg })
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

  async runRegistrationWizard(): Promise<{ appId: string; appSecret: string }> {
    const result = await registerApp({
      source: 'versperclaw',
      onQRCodeReady: info => {
        log.info('wizard', 'qr-ready', {
          url: info.url,
          expireIn: info.expireIn,
        })
      },
      onStatusChange: info => {
        log.info('wizard', 'status', { status: info.status })
      },
    })

    log.info('wizard', 'complete', { appId: result.client_id })

    saveFeishuConfig({
      appId: result.client_id,
      appSecret: result.client_secret,
    })

    return {
      appId: result.client_id,
      appSecret: result.client_secret,
    }
  }

  async stop(): Promise<void> {
    this.runId++
    if (this.ownerRefresh) {
      this.ownerRefresh.stop()
      this.ownerRefresh = undefined
    }
    if (this.keepalive) {
      this.keepalive.stop()
      this.keepalive = undefined
    }
    if (this.pending) {
      this.pending.cancelAll()
      this.pending = undefined
    }
    if (this.channel) {
      try {
        await this.channel.disconnect()
      } catch {}
      this.channel = undefined
    }
    this.chatModeCache = undefined
    this.config = undefined
    this.controls = new FeishuRuntimeControls()
    if (this.state.status !== 'stopped') {
      this.setState({ status: 'stopped' })
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.channel) return
    try {
      await this.channel.send(chatId, { text })
    } catch (err) {
      log.fail('send', err, { chatId, textLen: text.length })
    }
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    if (!this.channel) return
    try {
      const { optimizeMarkdownForFeishu } = await import(
        '../../utils/feishuMarkdown.js'
      )
      const optimized = optimizeMarkdownForFeishu(markdown)
      await this.channel.send(chatId, { markdown: optimized })
    } catch (err) {
      log.fail('send', err, { chatId, markdownLen: markdown.length })
    }
  }

  async sendVoice(chatId: string, text: string): Promise<void> {
    if (!this.channel) return
    try {
      const config = getFeishuConfig()
      if (!config.ttsEnabled) return

      const { readFile, unlink } = await import('node:fs/promises')
      const { spawn } = await import('node:child_process')

      const provider = config.ttsProvider || 'edge'
      const timestamp = Date.now()
      const rawBase = path.join(os.tmpdir(), `feishu_tts_raw_${timestamp}`)
      const oggPath = path.join(os.tmpdir(), `feishu_tts_${timestamp}.ogg`)

      if (provider === 'voxcpm') {
        const refAudio = config.ttsReferenceAudio
        if (!refAudio) {
          console.log('[feishu][tts] voxcpm: no ttsReferenceAudio configured')
          return
        }
        console.log('[feishu][tts] voxcpm: synthesizing with ref:', refAudio, 'output base:', rawBase)

        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            '/home/yuki/Code/Agent/VersperClaw/.venv/bin/voxcpm',
            ['clone', '--text', text, '--reference-audio', refAudio, '--denoise', '--output', `${rawBase}.wav`],
            { shell: false },
          )
          let stdout = ''
          let stderr = ''
          child.stdout?.on('data', c => { stdout += String(c) })
          child.stderr?.on('data', c => { stderr += String(c) })
          child.on('close', code => {
            console.log('[feishu][tts] voxcpm exit code:', code)
            if (code === 0) resolve()
            else reject(new Error(`voxcpm exit ${code}: ${stderr.slice(0, 200)}`))
          })
          child.on('error', reject)
        })
      } else {
        const voice = config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
        console.log('[feishu][tts] edge-tts: voice:', voice, 'text len:', text.length)

        await new Promise<void>((resolve, reject) => {
          const child = spawn('edge-tts', [
            '--voice', voice,
            '--text', text,
            '--write-media', rawBase,
          ])
          let stderr = ''
          child.stderr?.on('data', c => { stderr += String(c) })
          child.on('close', code => {
            console.log('[feishu][tts] edge-tts exit code:', code)
            if (code === 0) resolve()
            else reject(new Error(`edge-tts exit ${code}: ${stderr.slice(0, 200)}`))
          })
          child.on('error', reject)
        })
      }

      const rawPath = provider === 'voxcpm' ? `${rawBase}.wav` : rawBase
      console.log('[feishu][tts] raw audio at:', rawPath)

      // Convert raw → OGG/Opus (Feishu voice requires opus format)
      console.log('[feishu][tts] converting to OGG/Opus')
      await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', [
          '-i', rawPath,
          '-c:a', 'libopus',
          '-b:a', '128k',
          '-y',
          oggPath,
        ])
        child.on('close', code => {
          console.log('[feishu][tts] ffmpeg exit code:', code)
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg exit ${code}`))
        })
        child.on('error', reject)
      })

      const buffer = await readFile(oggPath)
      console.log('[feishu][tts] sending audio buffer, size:', buffer.length)
      await this.channel.send(chatId, { audio: { source: buffer } })
      console.log('[feishu][tts] sent successfully')

      // Clean up temp files
      await unlink(rawPath).catch(() => {})
      await unlink(oggPath).catch(() => {})
    } catch (err) {
      // Don't let TTS failure break the main message flow
      console.log('[feishu][tts] send-voice-failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onMessagesChange(_messages: unknown[], _isLoading: boolean): void {
    // No-op
  }

  // ── Internal ────────────────────────────────

  private setState(next: Partial<FeishuServiceState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }
}

export const feishuService = new FeishuService()
