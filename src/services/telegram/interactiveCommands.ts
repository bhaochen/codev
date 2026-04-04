import type { AppStateStore } from '../../state/AppState.js'
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js'
import {
  clearFastModeCooldown,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import {
  getModelOptions,
  type ModelOption,
} from '../../utils/model/modelOptions.js'
import { fetchCopilotModels } from '../api/copilotClient.js'
import {
  fetchAnthropicCompatibleModelIds,
  fetchOpenAICompatibleModelIds,
} from '../api/customOpenAIClient.js'
import { telegramService } from './TelegramService.js'
import type {
  TelegramCallbackEvent,
  TelegramInboundEvent,
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
} from './telegramTypes.js'

// 辅助函数：记录 Telegram 相关日志
function logTelegramDebug(message: string, level: 'debug' | 'error' | 'info' = 'debug'): void {
  logForDebugging(`[telegram] ${message}`, { level })
}

const COPILOT_CLIENT_ID = 'Ov23li8tweQw6odWQebz'
const COPILOT_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const COPILOT_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

const MODEL_PREFIX = 'tg:model'
const CONNECT_PREFIX = 'tg:connect'
const LOGIN_PREFIX = 'tg:login'

type ConnectPendingState =
  | { kind: 'openrouter-api-key' }
  | { kind: 'custom-openai-base' }
  | { kind: 'custom-openai-key'; baseUrl: string }
  | { kind: 'custom-anthropic-base' }
  | { kind: 'custom-anthropic-key'; baseUrl: string }

type ConnectModelSelectionState = {
  providerId: 'custom-openai' | 'custom-anthropic'
  baseUrl: string
  apiKey?: string
  models: string[]
}

const pendingConnectInputs = new Map<string, ConnectPendingState>()
const pendingModelMenus = new Map<string, ModelOption[]>()
const pendingConnectModelMenus = new Map<string, ConnectModelSelectionState>()

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size))
  }
  return rows
}

function createKeyboard(
  rows: TelegramInlineKeyboardButton[][],
): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: rows }
}

function buildModelKeyboard(options: ModelOption[]): TelegramInlineKeyboardMarkup {
  return createKeyboard(
    chunk(
      options.map((option, index) => ({
        text: option.label,
        callback_data: `${MODEL_PREFIX}:select:${index}`,
      })),
      2,
    ),
  )
}

function buildConnectKeyboard(): TelegramInlineKeyboardMarkup {
  return createKeyboard([
    [
      { text: 'GitHub Copilot', callback_data: `${CONNECT_PREFIX}:provider:github-copilot` },
      { text: 'OpenRouter', callback_data: `${CONNECT_PREFIX}:provider:openrouter` },
    ],
    [
      { text: 'Custom OpenAI', callback_data: `${CONNECT_PREFIX}:provider:custom-openai` },
      { text: 'Custom Anthropic', callback_data: `${CONNECT_PREFIX}:provider:custom-anthropic` },
    ],
  ])
}

function buildLoginKeyboard(): TelegramInlineKeyboardMarkup {
  return createKeyboard([
    [
      { text: 'Anthropic', callback_data: `${LOGIN_PREFIX}:provider:anthropic` },
      { text: 'OpenAI', callback_data: `${LOGIN_PREFIX}:provider:openai` },
    ],
    [
      { text: 'OpenRouter', callback_data: `${LOGIN_PREFIX}:provider:openrouter` },
      { text: 'Local', callback_data: `${LOGIN_PREFIX}:provider:local` },
    ],
  ])
}

function buildSkipKeyKeyboard(providerId: 'custom-openai' | 'custom-anthropic') {
  return createKeyboard([
    [
      {
        text: '跳过 API Key',
        callback_data: `${CONNECT_PREFIX}:skipkey:${providerId}`,
      },
    ],
  ])
}

function buildModelSelectionKeyboard(
  providerId: 'custom-openai' | 'custom-anthropic',
  models: string[],
): TelegramInlineKeyboardMarkup {
  return createKeyboard(
    chunk(
      models.map((model, index) => ({
        text: model,
        callback_data: `${CONNECT_PREFIX}:model:${providerId}:${index}`,
      })),
      1,
    ),
  )
}

function renderModelSelectionText(store: AppStateStore, options: ModelOption[]): string {
  const state = store.getState()
  const current = state.mainLoopModel
  const currentLabel = renderDefaultModelSetting(
    current ?? getDefaultMainLoopModelSetting(),
  )
  const lines = [
    `当前模型: ${currentLabel}${current === null ? ' (default)' : ''}`,
    '',
    '请选择要切换的模型：',
  ]

  options.forEach((option, index) => {
    lines.push(`${index + 1}. ${option.label} - ${option.description}`)
  })

  return lines.join('\n')
}

function applyModelSelection(
  store: AppStateStore,
  model: ModelOption['value'],
): string {
  const state = store.getState()
  let message = `已切换到模型 ${renderDefaultModelSetting(model ?? getDefaultMainLoopModelSetting())}${model === null ? ' (default)' : ''}`
  let wasFastModeToggledOn: boolean | undefined

  store.setState(prev => ({
    ...prev,
    mainLoopModel: model,
    mainLoopModelForSession: null,
  }))

  if (isFastModeEnabled()) {
    clearFastModeCooldown()
    if (!isFastModeSupportedByModel(model) && state.fastMode) {
      store.setState(prev => ({
        ...prev,
        fastMode: false,
      }))
      wasFastModeToggledOn = false
    } else if (
      isFastModeSupportedByModel(model) &&
      isFastModeAvailable() &&
      state.fastMode
    ) {
      message += ' · Fast mode ON'
      wasFastModeToggledOn = true
    }
  }

  if (isBilledAsExtraUsage(model, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
    message += ' · Billed as extra usage'
  }

  if (wasFastModeToggledOn === false) {
    message += ' · Fast mode OFF'
  }

  return message
}

async function beginCopilotOAuth(chatId: string): Promise<void> {
  const response = await fetch(COPILOT_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: 'read:user',
    }),
  })

  if (!response.ok) {
    throw new Error('无法发起 GitHub Copilot 设备授权')
  }

  const data = (await response.json()) as {
    verification_uri: string
    user_code: string
    device_code: string
    interval: number
  }

  await telegramService.sendMessage(
    chatId,
    [
      'GitHub Copilot 连接已开始。',
      `1. 打开: ${data.verification_uri}`,
      `2. 输入代码: ${data.user_code}`,
      '授权完成后，我会自动继续。',
    ].join('\n'),
  )

  void pollCopilotOAuth(chatId, data)
}

async function pollCopilotOAuth(
  chatId: string,
  data: {
    device_code: string
    interval: number
  },
): Promise<void> {
  let currentInterval = data.interval

  while (true) {
    await new Promise(resolve =>
      setTimeout(resolve, currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS),
    )

    const response = await fetch(COPILOT_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: data.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    if (!response.ok) {
      throw new Error('获取 GitHub Copilot access token 失败')
    }

    const result = (await response.json()) as {
      access_token?: string
      error?: string
      interval?: number
    }

    if (result.access_token) {
      saveGlobalConfig(current => ({
        ...current,
        connectedProviders: {
          ...(current.connectedProviders || {}),
          'github-copilot': {
            oauthToken: result.access_token,
            connectedAt: new Date().toISOString(),
          },
        },
        activeProvider: current.activeProvider || 'github-copilot',
      }))

      fetchCopilotModels()
        .then(models => {
          saveGlobalConfig(current => ({
            ...current,
            copilotModelsCache: { models, fetchedAt: Date.now() },
          }))
        })
        .catch(() => {})

      await telegramService.sendMessage(
        chatId,
        'GitHub Copilot 已连接成功。之后可用 /model 选择 Copilot 模型。',
      )
      return
    }

    if (result.error === 'authorization_pending') {
      continue
    }

    if (result.error === 'slow_down') {
      currentInterval = result.interval ?? currentInterval + 5
      continue
    }

    if (result.error === 'expired_token') {
      throw new Error('GitHub Copilot 授权已过期，请重新执行 /connect')
    }

    if (result.error === 'access_denied') {
      throw new Error('GitHub Copilot 授权被拒绝')
    }

    if (result.error) {
      throw new Error(`GitHub Copilot OAuth 错误: ${result.error}`)
    }
  }
}

async function handleConnectTextInput(
  chatId: string,
  text: string,
): Promise<boolean> {
  const pending = pendingConnectInputs.get(chatId)
  if (!pending) return false

  pendingConnectInputs.delete(chatId)

  switch (pending.kind) {
    case 'openrouter-api-key': {
      if (!text.trim()) {
        await telegramService.sendMessage(chatId, 'API Key 不能为空，请重新执行 /connect。')
        return true
      }
      saveGlobalConfig(current => ({
        ...current,
        connectedProviders: {
          ...(current.connectedProviders || {}),
          openrouter: {
            apiKey: text.trim(),
            connectedAt: new Date().toISOString(),
          },
        },
        activeProvider: current.activeProvider || 'openrouter',
      }))
      await telegramService.sendMessage(chatId, 'OpenRouter 已连接成功。')
      return true
    }
    case 'custom-openai-base': {
      const baseUrl = text.trim()
      if (!baseUrl) {
        await telegramService.sendMessage(chatId, 'Base URL 不能为空，请重新执行 /connect。')
        return true
      }
      pendingConnectInputs.set(chatId, {
        kind: 'custom-openai-key',
        baseUrl,
      })
      await telegramService.sendMessage(
        chatId,
        '请输入 Custom OpenAI 的 API Key，或者点击下方按钮跳过。',
        buildSkipKeyKeyboard('custom-openai'),
      )
      return true
    }
    case 'custom-anthropic-base': {
      const baseUrl = text.trim()
      if (!baseUrl) {
        await telegramService.sendMessage(chatId, 'Base URL 不能为空，请重新执行 /connect。')
        return true
      }
      pendingConnectInputs.set(chatId, {
        kind: 'custom-anthropic-key',
        baseUrl,
      })
      await telegramService.sendMessage(
        chatId,
        '请输入 Custom Anthropic 的 API Key，或者点击下方按钮跳过。',
        buildSkipKeyKeyboard('custom-anthropic'),
      )
      return true
    }
    case 'custom-openai-key': {
      await startCustomProviderModelFetch(
        chatId,
        'custom-openai',
        pending.baseUrl,
        text.trim() || undefined,
      )
      return true
    }
    case 'custom-anthropic-key': {
      await startCustomProviderModelFetch(
        chatId,
        'custom-anthropic',
        pending.baseUrl,
        text.trim() || undefined,
      )
      return true
    }
  }
}

async function startCustomProviderModelFetch(
  chatId: string,
  providerId: 'custom-openai' | 'custom-anthropic',
  baseUrl: string,
  apiKey?: string,
): Promise<void> {
  const models =
    providerId === 'custom-openai'
      ? await fetchOpenAICompatibleModelIds(baseUrl, apiKey)
      : await fetchAnthropicCompatibleModelIds(baseUrl, apiKey)

  if (models.length === 0) {
    await telegramService.sendMessage(
      chatId,
      '没有从 /v1/models 获取到可用模型，请检查 Base URL 或 API Key。',
    )
    return
  }

  pendingConnectModelMenus.set(chatId, {
    providerId,
    baseUrl,
    apiKey,
    models,
  })

  await telegramService.sendMessage(
    chatId,
    `请选择 ${providerId === 'custom-openai' ? 'Custom OpenAI' : 'Custom Anthropic'} 的默认模型：`,
    buildModelSelectionKeyboard(providerId, models),
  )
}

export async function maybeHandleTelegramInteractiveInput(
  event: TelegramInboundEvent,
  store: AppStateStore,
): Promise<boolean> {
  const text = event.text.trim()

  if (await handleConnectTextInput(event.chatId, text)) {
    return true
  }

  if (text === '/model') {
    const options = getModelOptions(store.getState().fastMode).slice(0, 20)
    pendingModelMenus.set(event.chatId, options)
    await telegramService.sendMessage(
      event.chatId,
      renderModelSelectionText(store, options),
      buildModelKeyboard(options),
    )
    return true
  }

  if (text === '/connect') {
    await telegramService.sendMessage(
      event.chatId,
      '请选择要连接的 provider：',
      buildConnectKeyboard(),
    )
    return true
  }

  if (text === '/login') {
    await telegramService.sendMessage(
      event.chatId,
      '请选择登录方式：\n\nAnthropic - Anthropic 账户登录\nOpenAI - OpenAI / Codex 登录\nOpenRouter - OpenRouter API Key\nLocal - 本地模型服务器',
      buildLoginKeyboard(),
    )
    return true
  }

  return false
}

export async function handleTelegramCallback(
  event: TelegramCallbackEvent,
  store: AppStateStore,
): Promise<boolean> {
  if (event.data.startsWith(`${MODEL_PREFIX}:select:`)) {
    const index = Number(event.data.split(':').at(-1))
    const options = pendingModelMenus.get(event.chatId)
    const option = Number.isFinite(index) ? options?.[index] : undefined

    await telegramService.answerCallbackQuery(
      event.callbackQueryId,
      option ? `已选择 ${option.label}` : '模型选项已失效',
    )

    if (!option) {
      return true
    }

    const message = applyModelSelection(store, option.value)
    await telegramService.editMessage(event.chatId, event.messageId, message)
    pendingModelMenus.delete(event.chatId)
    return true
  }

  if (event.data.startsWith(`${CONNECT_PREFIX}:provider:`)) {
    const providerId = event.data.split(':').at(-1)
    await telegramService.answerCallbackQuery(event.callbackQueryId)

    switch (providerId) {
      case 'github-copilot':
        await telegramService.editMessage(
          event.chatId,
          event.messageId,
          'GitHub Copilot 正在发起设备授权，请稍候...',
        )
        await beginCopilotOAuth(event.chatId)
        return true
      case 'openrouter':
        pendingConnectInputs.set(event.chatId, { kind: 'openrouter-api-key' })
        await telegramService.editMessage(
          event.chatId,
          event.messageId,
          '请直接发送 OpenRouter API Key。',
        )
        return true
      case 'custom-openai':
        pendingConnectInputs.set(event.chatId, { kind: 'custom-openai-base' })
        await telegramService.editMessage(
          event.chatId,
          event.messageId,
          '请直接发送 Custom OpenAI 的 Base URL。',
        )
        return true
      case 'custom-anthropic':
        pendingConnectInputs.set(event.chatId, { kind: 'custom-anthropic-base' })
        await telegramService.editMessage(
          event.chatId,
          event.messageId,
          '请直接发送 Custom Anthropic 的 Base URL。',
        )
        return true
      default:
        await telegramService.editMessage(
          event.chatId,
          event.messageId,
          '暂不支持这个 provider。',
        )
        return true
    }
  }

  if (event.data.startsWith(`${CONNECT_PREFIX}:skipkey:`)) {
    const providerId = event.data.split(':').at(-1)
    const pending = pendingConnectInputs.get(event.chatId)
    await telegramService.answerCallbackQuery(event.callbackQueryId)

    if (
      providerId === 'custom-openai' &&
      pending?.kind === 'custom-openai-key'
    ) {
      pendingConnectInputs.delete(event.chatId)
      await telegramService.editMessage(
        event.chatId,
        event.messageId,
        '正在获取 Custom OpenAI 模型列表...',
      )
      await startCustomProviderModelFetch(
        event.chatId,
        'custom-openai',
        pending.baseUrl,
      )
      return true
    }

    if (
      providerId === 'custom-anthropic' &&
      pending?.kind === 'custom-anthropic-key'
    ) {
      pendingConnectInputs.delete(event.chatId)
      await telegramService.editMessage(
        event.chatId,
        event.messageId,
        '正在获取 Custom Anthropic 模型列表...',
      )
      await startCustomProviderModelFetch(
        event.chatId,
        'custom-anthropic',
        pending.baseUrl,
      )
      return true
    }

    return true
  }

  if (event.data.startsWith(`${CONNECT_PREFIX}:model:`)) {
    const [, , , providerId, indexRaw] = event.data.split(':')
    const selection = pendingConnectModelMenus.get(event.chatId)
    const index = Number(indexRaw)
    const model = Number.isFinite(index) ? selection?.models[index] : undefined

    await telegramService.answerCallbackQuery(
      event.callbackQueryId,
      model ? `已选择 ${model}` : '模型选项已失效',
    )

    if (
      !selection ||
      !model ||
      (providerId !== 'custom-openai' && providerId !== 'custom-anthropic')
    ) {
      return true
    }

    if (providerId !== selection.providerId) {
      return true
    }

    saveGlobalConfig(current => ({
      ...current,
      connectedProviders: {
        ...(current.connectedProviders || {}),
        [providerId]: {
          baseUrl: selection.baseUrl,
          defaultModel: model,
          ...(selection.apiKey ? { apiKey: selection.apiKey } : {}),
          connectedAt: new Date().toISOString(),
        },
      },
      activeProvider: providerId,
      ...(providerId === 'custom-openai'
        ? {
            openaiCustomModelsCache: selection.models.map(id => ({ id })),
          }
        : {
            anthropicCustomModelsCache: selection.models.map(id => ({ id })),
          }),
    }))

    pendingConnectModelMenus.delete(event.chatId)
    await telegramService.editMessage(
      event.chatId,
      event.messageId,
      `${providerId === 'custom-openai' ? 'Custom OpenAI' : 'Custom Anthropic'} 已连接成功，默认模型为 ${model}。`,
    )
    return true
  }

  if (event.data.startsWith(`${LOGIN_PREFIX}:provider:`)) {
    const providerId = event.data.split(':').at(-1)
    await telegramService.answerCallbackQuery(event.callbackQueryId)

    if (providerId === 'openrouter') {
      // 检查是否已有 OpenRouter API Key
      const config = getGlobalConfig()
      const existingApiKey = config.openRouterApiKey || process.env.OPENROUTER_API_KEY
      
      logTelegramDebug(`[telegram] checking openrouter config: hasApiKeyInConfig=${!!config.openRouterApiKey}, hasApiKeyInEnv=${!!process.env.OPENROUTER_API_KEY}`)
      
      if (existingApiKey) {
        try {
          // 保存配置并切换到 OpenRouter
          saveGlobalConfig(current => ({
            ...current,
            authProvider: 'openrouter',
            openRouterApiKey: existingApiKey,
            additionalModelOptionsCache: [], // 清除之前的模型缓存
          }))
          
          // 清除 provider 缓存和模型缓存
          const { clearStoredProviderCache } = await import('../../utils/model/providers.js')
          clearStoredProviderCache()
          
          try {
            // 清除 OpenRouter 模型缓存
            const openRouterModule = await import('../../utils/model/openRouterModels.js')
            openRouterModule.clearOpenRouterModelsCache()
          } catch (error) {
            // 忽略错误，可能模块不可用
            logTelegramDebug(`[telegram] failed to clear openrouter cache: ${error instanceof Error ? error.message : String(error)}`, 'error')
          }

          // 更新应用状态，触发 UI 刷新
          store.setState(prev => ({
            ...prev,
            mainLoopModel: 'default', // 使用 'default' 让系统自动选择正确的默认模型
            mainLoopModelForSession: null,
            authVersion: prev.authVersion + 1, // 触发全局更新
          }))

          await telegramService.editMessage(
            event.chatId,
            event.messageId,
            `✅ 已切换到 OpenRouter (使用已配置的 API Key)\n\n当前状态：已登录 OpenRouter`,
          )
          return true
        } catch (error) {
          await telegramService.editMessage(
            event.chatId,
            event.messageId,
            `❌ 切换到 OpenRouter 失败: ${error instanceof Error ? error.message : String(error)}`,
          )
          return true
        }
      }
    }

    if (providerId === 'local') {
      // 检查是否已有本地模型配置
      const config = getGlobalConfig()
      const localBaseUrl = config.localBaseUrl
      const localModelName = config.localModelName
      
      logTelegramDebug(`[telegram] checking local config: baseUrl=${localBaseUrl}, modelName=${localModelName}, fullConfig=${JSON.stringify(config)}`)
      
      if (localBaseUrl && localModelName) {
        try {
          // 保存配置并切换到本地模型
          saveGlobalConfig(current => ({
            ...current,
            authProvider: 'local',
            localBaseUrl: localBaseUrl,
            localModelName: localModelName,
            additionalModelOptionsCache: [], // 清除之前的模型缓存
          }))
          
          // 清除 provider 缓存
          const { clearStoredProviderCache } = await import('../../utils/model/providers.js')
          clearStoredProviderCache()

          // 更新应用状态，触发 UI 刷新
          store.setState(prev => ({
            ...prev,
            mainLoopModel: 'default', // 使用 'default' 让系统自动选择正确的默认模型
            mainLoopModelForSession: null,
            authVersion: prev.authVersion + 1, // 触发全局更新
          }))

          await telegramService.editMessage(
            event.chatId,
            event.messageId,
            `✅ 已切换到本地模型\n\nBase URL: ${localBaseUrl}\n模型名称: ${localModelName}`,
          )
          return true
        } catch (error) {
          await telegramService.editMessage(
            event.chatId,
            event.messageId,
            `❌ 切换到本地模型失败: ${error instanceof Error ? error.message : String(error)}`,
          )
          return true
        }
      }
    }

    const providerMessages: Record<string, string> = {
      'anthropic': 'Anthropic 登录需要在本地终端执行 /login 命令，Telegram 暂不支持浏览器 OAuth 流程。',
      'openai': 'OpenAI 登录需要在本地终端执行 /login 命令，Telegram 暂不支持交互式登录。',
      'openrouter': 'OpenRouter 登录需要在本地终端执行 /login 命令或配置环境变量 OPENROUTER_API_KEY，Telegram 暂不支持 API Key 输入。',
      'local': '本地模型配置需要在本地终端执行 /login 命令，配置 Base URL 和模型名称。',
    }

    await telegramService.editMessage(
      event.chatId,
      event.messageId,
      providerMessages[providerId] || '暂不支持此登录方式。',
    )
    return true
  }

  return false
}

export function clearTelegramInteractiveState(chatId?: string): void {
  if (chatId) {
    pendingConnectInputs.delete(chatId)
    pendingModelMenus.delete(chatId)
    pendingConnectModelMenus.delete(chatId)
    return
  }

  pendingConnectInputs.clear()
  pendingModelMenus.clear()
  pendingConnectModelMenus.clear()
}

export function logTelegramInteractiveError(error: unknown): void {
  logForDebugging(
    `[telegram] interactive handler failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { level: 'error' },
  )
}
