import { getGlobalConfig, saveGlobalConfig, type ConnectedProviderInfo } from '../../utils/config.js'

const COPILOT_API_BASE = 'https://api.githubcopilot.com'
const MODELS_DEV_URL = 'https://models.dev/api.json'

export type CopilotModelInfo = {
  id: string
  label: string
  description: string
  supportedEndpoints?: string[]
}

type CopilotOutputTokenParam = 'max_tokens' | 'max_completion_tokens'
type CopilotCompatibilityInfo = {
  outputTokenParam?: CopilotOutputTokenParam
  modelSupported?: boolean
  chatCompletionsSupported?: boolean
  updatedAt: number
}

const COPILOT_COMPATIBILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const COPILOT_CHAT_COMPLETIONS_ENDPOINT = '/chat/completions'

export function isCopilotModel(model: string): boolean {
  return model.startsWith('copilot:')
}

export function getCopilotModelId(model: string): string {
  return model.replace(/^copilot:/, '')
}

export function getCopilotProvider(): ConnectedProviderInfo | undefined {
  const config = getGlobalConfig()
  return config.connectedProviders?.['github-copilot']
}

export function isCopilotConnected(): boolean {
  return !!getCopilotProvider()?.oauthToken
}

const FALLBACK_COPILOT_MODELS: CopilotModelInfo[] = [
  { id: 'copilot:claude-sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'Claude Sonnet 4.6 via Copilot' },
  { id: 'copilot:claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'Claude Sonnet 4.5 via Copilot' },
  { id: 'copilot:claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Claude Sonnet 4 via Copilot' },
  { id: 'copilot:claude-opus-4.6', label: 'Claude Opus 4.6', description: 'Claude Opus 4.6 via Copilot' },
  { id: 'copilot:claude-opus-4.5', label: 'Claude Opus 4.5', description: 'Claude Opus 4.5 via Copilot' },
  { id: 'copilot:claude-opus-41', label: 'Claude Opus 4.1', description: 'Claude Opus 4.1 via Copilot' },
  { id: 'copilot:claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'Claude Haiku 4.5 via Copilot' },
  { id: 'copilot:gpt-5.4', label: 'GPT-5.4', description: 'OpenAI GPT-5.4 via Copilot' },
  { id: 'copilot:gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI GPT-5.4 mini via Copilot' },
  { id: 'copilot:gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'OpenAI GPT-5.3-Codex via Copilot' },
  { id: 'copilot:gpt-5.2-codex', label: 'GPT-5.2-Codex', description: 'OpenAI GPT-5.2-Codex via Copilot' },
  { id: 'copilot:gpt-5.2', label: 'GPT-5.2', description: 'OpenAI GPT-5.2 via Copilot' },
  { id: 'copilot:gpt-5.1', label: 'GPT-5.1', description: 'OpenAI GPT-5.1 via Copilot' },
  { id: 'copilot:gpt-5.1-codex', label: 'GPT-5.1-Codex', description: 'OpenAI GPT-5.1-Codex via Copilot' },
  { id: 'copilot:gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-mini', description: 'OpenAI GPT-5.1-Codex-mini via Copilot' },
  { id: 'copilot:gpt-5.1-codex-max', label: 'GPT-5.1-Codex-max', description: 'OpenAI GPT-5.1-Codex-max via Copilot' },
  { id: 'copilot:gpt-5', label: 'GPT-5', description: 'OpenAI GPT-5 via Copilot' },
  { id: 'copilot:gpt-5-mini', label: 'GPT-5-mini', description: 'OpenAI GPT-5-mini via Copilot' },
  { id: 'copilot:gpt-4.1', label: 'GPT-4.1', description: 'OpenAI GPT-4.1 via Copilot' },
  { id: 'copilot:gpt-4o', label: 'GPT-4o', description: 'OpenAI GPT-4o via Copilot' },
  { id: 'copilot:gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', description: 'Google Gemini 3.1 Pro via Copilot' },
  { id: 'copilot:gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', description: 'Google Gemini 3 Pro via Copilot' },
  { id: 'copilot:gemini-3-flash-preview', label: 'Gemini 3 Flash', description: 'Google Gemini 3 Flash via Copilot' },
  { id: 'copilot:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Google Gemini 2.5 Pro via Copilot' },
  { id: 'copilot:grok-code-fast-1', label: 'Grok Code Fast 1', description: 'xAI Grok Code Fast 1 via Copilot' },
]

let cachedModels: CopilotModelInfo[] | null = null
let copilotModelsRefreshPromise: Promise<void> | null = null

type CopilotApiModel = {
  id: string
  name?: string
  model_picker_enabled?: boolean
  policy?: { state?: string }
  supported_endpoints?: string[]
}

function supportsCopilotChatCompletions(model: CopilotModelInfo): boolean {
  return (
    !model.supportedEndpoints ||
    model.supportedEndpoints.includes(COPILOT_CHAT_COMPLETIONS_ENDPOINT)
  )
}

export async function fetchCopilotModelsFromApi(): Promise<CopilotModelInfo[] | null> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) return null

  const response = await fetch(`${COPILOT_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${provider.oauthToken}`,
      'User-Agent': 'claude-code/2.1.88',
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'user',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Copilot models API failed (${response.status})`)
  }

  const data = await response.json() as {
    data?: CopilotApiModel[]
  }
  if (!Array.isArray(data.data) || data.data.length === 0) {
    return null
  }

  const models = data.data
    .filter(model => model.model_picker_enabled !== false)
    .filter(model => model.policy?.state !== 'disabled')
    .map(
      (model): CopilotModelInfo => ({
        id: `copilot:${model.id}`,
        label: model.name || model.id,
        description: `${model.name || model.id} via Copilot`,
        supportedEndpoints: model.supported_endpoints,
      }),
    )

  return models.length > 0 ? models : null
}

export async function fetchCopilotModelsFromModelsDev(): Promise<CopilotModelInfo[]> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return FALLBACK_COPILOT_MODELS

    const data = await response.json() as Record<string, { models?: Record<string, { name?: string }> }>
    const copilotProvider = data['github-copilot']
    if (!copilotProvider?.models) return FALLBACK_COPILOT_MODELS

    const models: CopilotModelInfo[] = Object.entries(copilotProvider.models).map(
      ([modelId, info]) => ({
        id: `copilot:${modelId}`,
        label: info.name || modelId,
        description: `${info.name || modelId} via Copilot`,
      }),
    )

    return models.length > 0 ? models : FALLBACK_COPILOT_MODELS
  } catch {
    return FALLBACK_COPILOT_MODELS
  }
}

export async function fetchCopilotModels(): Promise<CopilotModelInfo[]> {
  try {
    const apiModels = await fetchCopilotModelsFromApi()
    if (apiModels && apiModels.length > 0) {
      return apiModels
    }
  } catch {}

  return fetchCopilotModelsFromModelsDev()
}

function hasCopilotEndpointMetadata(models: CopilotModelInfo[]): boolean {
  return models.some(model => Array.isArray(model.supportedEndpoints))
}

function shouldUseCachedCopilotModels(cache: {
  models: CopilotModelInfo[]
  fetchedAt: number
} | null | undefined): boolean {
  if (!cache || cache.models.length === 0) return false
  if (!hasCopilotEndpointMetadata(cache.models)) return false
  return Date.now() - cache.fetchedAt < 3600_000
}

function refreshCopilotModelsCacheInBackground(): void {
  if (copilotModelsRefreshPromise || !isCopilotConnected()) {
    return
  }
  copilotModelsRefreshPromise = (async () => {
    const models = await fetchCopilotModels()
    cachedModels = models
    saveGlobalConfig(current => ({
      ...current,
      copilotModelsCache: { models, fetchedAt: Date.now() },
    }))
  })()
    .catch(() => {})
    .finally(() => {
      copilotModelsRefreshPromise = null
    })
}

export async function getCopilotModels(): Promise<CopilotModelInfo[]> {
  if (cachedModels) return filterUnavailableCopilotModels(cachedModels)

  const config = getGlobalConfig()
  const cached = config.copilotModelsCache
  if (shouldUseCachedCopilotModels(cached)) {
    cachedModels = cached.models
    return filterUnavailableCopilotModels(cachedModels)
  }

  const models = await fetchCopilotModels()
  cachedModels = models

  saveGlobalConfig(current => ({
    ...current,
    copilotModelsCache: { models, fetchedAt: Date.now() },
  }))

  return filterUnavailableCopilotModels(models)
}

export function getCopilotModelsCached(): CopilotModelInfo[] {
  if (cachedModels) {
    if (!hasCopilotEndpointMetadata(cachedModels)) {
      refreshCopilotModelsCacheInBackground()
    }
    return filterUnavailableCopilotModels(cachedModels)
  }

  const config = getGlobalConfig()
  const cached = config.copilotModelsCache
  if (cached && cached.models.length > 0) {
    cachedModels = cached.models
    if (!shouldUseCachedCopilotModels(cached)) {
      refreshCopilotModelsCacheInBackground()
    }
    return filterUnavailableCopilotModels(cachedModels)
  }

  refreshCopilotModelsCacheInBackground()
  return filterUnavailableCopilotModels(FALLBACK_COPILOT_MODELS)
}

export { FALLBACK_COPILOT_MODELS as COPILOT_MODELS }

function getCachedCopilotCompatibility(
  modelId: string,
): CopilotCompatibilityInfo | undefined {
  const compatibility = getGlobalConfig().copilotCompatibilityCache?.[modelId]
  if (!compatibility) return undefined
  if (Date.now() - compatibility.updatedAt > COPILOT_COMPATIBILITY_CACHE_TTL_MS) {
    return undefined
  }
  return compatibility
}

function filterUnavailableCopilotModels(
  models: CopilotModelInfo[],
): CopilotModelInfo[] {
  return models.filter(model => {
    if (!supportsCopilotChatCompletions(model)) {
      return false
    }
    const compatibility = getCachedCopilotCompatibility(
      getCopilotModelId(model.id),
    )
    return (
      compatibility?.modelSupported !== false &&
      compatibility?.chatCompletionsSupported !== false
    )
  })
}

function saveCopilotCompatibility(
  modelId: string,
  updates: Partial<CopilotCompatibilityInfo>,
): void {
  saveGlobalConfig(current => {
    const existing = current.copilotCompatibilityCache?.[modelId]
    const next = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    } satisfies CopilotCompatibilityInfo

    if (
      existing?.outputTokenParam === next.outputTokenParam &&
      existing?.modelSupported === next.modelSupported &&
      existing?.chatCompletionsSupported === next.chatCompletionsSupported
    ) {
      return current
    }

    return {
      ...current,
      copilotCompatibilityCache: {
        ...current.copilotCompatibilityCache,
        [modelId]: next,
      },
    }
  })
}

function getPreferredCopilotOutputTokenParam(
  modelId: string,
): CopilotOutputTokenParam {
  return (
    getCachedCopilotCompatibility(modelId)?.outputTokenParam ??
    'max_tokens'
  )
}

function savePreferredCopilotOutputTokenParam(
  modelId: string,
  outputTokenParam: CopilotOutputTokenParam,
): void {
  saveCopilotCompatibility(modelId, { outputTokenParam })
}

function buildCopilotChatRequestBody(params: {
  modelId: string
  messages: OpenAIMessage[]
  isStreaming: boolean
  maxTokens?: number
  tools?: OpenAITool[]
  outputTokenParam: CopilotOutputTokenParam
}): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model: params.modelId,
    messages: params.messages,
    stream: params.isStreaming,
  }

  // 流式时让服务端回传 usage chunk，否则 output_tokens 统计恒为 0
  if (params.isStreaming) {
    requestBody.stream_options = { include_usage: true }
  }

  if (params.maxTokens) {
    requestBody[params.outputTokenParam] = params.maxTokens
  }

  if (params.tools && params.tools.length > 0) {
    requestBody.tools = params.tools
    requestBody.tool_choice = 'auto'
  }

  return requestBody
}

async function createCopilotErrorInfo(response: Response): Promise<{
  message?: string
  code?: string
}> {
  const text = await response
    .clone()
    .text()
    .catch(() => '')
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string }
    }
    return {
      message: parsed.error?.message,
      code: parsed.error?.code,
    }
  } catch {
    return {}
  }
}

function createCachedCopilotErrorResponse(
  message: string,
  code: string,
): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}

function getSuggestedCopilotOutputTokenParam(
  currentParam: CopilotOutputTokenParam,
  errorMessage: string | undefined,
): CopilotOutputTokenParam | undefined {
  if (!errorMessage) return undefined
  if (
    currentParam === 'max_tokens' &&
    errorMessage.includes("Use 'max_completion_tokens' instead")
  ) {
    return 'max_completion_tokens'
  }
  if (
    currentParam === 'max_completion_tokens' &&
    errorMessage.includes("Use 'max_tokens' instead")
  ) {
    return 'max_tokens'
  }
  return undefined
}

async function postCopilotChatCompletion(params: {
  oauthToken: string
  requestBody: Record<string, unknown>
  signal?: AbortSignal
}): Promise<Response> {
  return fetch(`${COPILOT_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.oauthToken}`,
      'User-Agent': 'claude-code/2.1.88',
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'user',
    },
    body: JSON.stringify(params.requestBody),
    signal: params.signal,
  })
}

function saveCopilotCompatibilityFromError(
  modelId: string,
  errorInfo: { code?: string },
): void {
  if (errorInfo.code === 'model_not_supported') {
    saveCopilotCompatibility(modelId, {
      modelSupported: false,
      chatCompletionsSupported: false,
    })
  } else if (errorInfo.code === 'unsupported_api_for_model') {
    saveCopilotCompatibility(modelId, {
      chatCompletionsSupported: false,
    })
  }
}

async function sendCopilotChatCompletion(params: {
  oauthToken: string
  modelId: string
  messages: OpenAIMessage[]
  isStreaming: boolean
  maxTokens?: number
  tools?: OpenAITool[]
  signal?: AbortSignal
}): Promise<Response> {
  const compatibility = getCachedCopilotCompatibility(params.modelId)
  if (compatibility?.modelSupported === false) {
    return createCachedCopilotErrorResponse(
      `Copilot model "${params.modelId}" was previously rejected as unsupported.`,
      'model_not_supported',
    )
  }
  if (compatibility?.chatCompletionsSupported === false) {
    return createCachedCopilotErrorResponse(
      `Copilot model "${params.modelId}" does not support the /chat/completions endpoint.`,
      'unsupported_api_for_model',
    )
  }

  let outputTokenParam = getPreferredCopilotOutputTokenParam(params.modelId)
  let requestBody = buildCopilotChatRequestBody({
    modelId: params.modelId,
    messages: params.messages,
    isStreaming: params.isStreaming,
    maxTokens: params.maxTokens,
    tools: params.tools,
    outputTokenParam,
  })

  let response = await postCopilotChatCompletion({
    oauthToken: params.oauthToken,
    requestBody,
    signal: params.signal,
  })
  if (response.ok) {
    saveCopilotCompatibility(params.modelId, {
      modelSupported: true,
      chatCompletionsSupported: true,
      outputTokenParam,
    })
    return response
  }

  const errorInfo = await createCopilotErrorInfo(response)
  if (!params.maxTokens) {
    saveCopilotCompatibilityFromError(params.modelId, errorInfo)
    return response
  }
  const suggestedParam = getSuggestedCopilotOutputTokenParam(
    outputTokenParam,
    errorInfo.message,
  )
  if (!suggestedParam) {
    saveCopilotCompatibilityFromError(params.modelId, errorInfo)
    return response
  }

  savePreferredCopilotOutputTokenParam(params.modelId, suggestedParam)
  outputTokenParam = suggestedParam
  requestBody = buildCopilotChatRequestBody({
    modelId: params.modelId,
    messages: params.messages,
    isStreaming: params.isStreaming,
    maxTokens: params.maxTokens,
    tools: params.tools,
    outputTokenParam,
  })

  response = await postCopilotChatCompletion({
    oauthToken: params.oauthToken,
    requestBody,
    signal: params.signal,
  })
  if (response.ok) {
    saveCopilotCompatibility(params.modelId, {
      modelSupported: true,
      chatCompletionsSupported: true,
      outputTokenParam,
    })
    return response
  }

  saveCopilotCompatibilityFromError(
    params.modelId,
    await createCopilotErrorInfo(response),
  )
  return response
}

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  reasoning_content?: string
}

type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
  | { type: 'thinking'; thinking: string }
  | Record<string, unknown>

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/**
 * 追加一条 OpenAI 消息，若上一条是 assistant 且当前也是 assistant 则合并
 * （OpenAI 规范要求 user/assistant 交替，Anthropic 历史里可能出现连续 assistant 回合）。
 */
function pushMergedAssistant(
  result: OpenAIMessage[],
  msg: OpenAIMessage,
): void {
  const last = result[result.length - 1]
  if (last && last.role === 'assistant' && msg.role === 'assistant') {
    const newText = msg.content
    if (typeof newText === 'string' && newText) {
      last.content =
        typeof last.content === 'string' && last.content
          ? `${last.content}\n${newText}`
          : newText
    }
    if (msg.reasoning_content) {
      last.reasoning_content = last.reasoning_content
        ? `${last.reasoning_content}\n${msg.reasoning_content}`
        : msg.reasoning_content
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls]
    }
    return
  }
  result.push(msg)
}

function base64ImageUrl(source: {
  type?: string
  media_type?: string
  data?: string
}): string | undefined {
  if (source?.type !== 'base64' || !source.media_type || !source.data) {
    return undefined
  }
  return `data:${source.media_type};base64,${source.data}`
}

/**
 * Anthropic document 块无法直接映射到 OpenAI 格式。文本型 source 提取为 text，
 * 其余（base64 PDF 等）无法表达则丢弃，但保证不中断转换。
 */
function extractDocumentText(
  doc: { source?: { type?: string; data?: unknown } },
): string | undefined {
  const src = doc?.source
  if (src?.type === 'text' && typeof src.data === 'string') {
    return src.data
  }
  return undefined
}

/**
 * 规范化 tool_result 的 content：纯文本返回字符串；含图片时返回
 * text + image_url 数组（OpenAI 的 tool message 支持数组 content）。
 */
function normalizeToolResultContent(
  content: unknown,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const textParts: string[] = []
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  let hasImage = false
  for (const c of content as Array<{
    type?: string
    text?: string
    source?: { type?: string; media_type?: string; data?: string }
  }>) {
    if (c?.type === 'text') {
      textParts.push(c.text ?? '')
      parts.push({ type: 'text', text: c.text ?? '' })
    } else if (c?.type === 'image') {
      const url = base64ImageUrl(c.source ?? {})
      if (url) {
        hasImage = true
        parts.push({ type: 'image_url', image_url: { url } })
      }
    } else if (c?.type === 'document') {
      const text = extractDocumentText(c as unknown as {
        source?: { type?: string; data?: unknown }
      })
      if (text) {
        textParts.push(text)
        parts.push({ type: 'text', text })
      }
    }
  }
  if (hasImage) {
    return parts
  }
  return textParts.join('\n')
}

export function convertAnthropicMessagesToOpenAI(
  messages: AnthropicMessage[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      pushMergedAssistant(result, { role: msg.role, content: msg.content })
      continue
    }

    // 异常输入（content 非 string 非数组）：保留消息避免破坏对话配对
    if (!Array.isArray(msg.content)) {
      pushMergedAssistant(result, { role: msg.role, content: null })
      continue
    }

    if (msg.role === 'user') {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      const toolResults: OpenAIMessage[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: (block as { type: 'text'; text: string }).text })
        } else if (block.type === 'image') {
          const imgBlock = block as {
            type: 'image'
            source?: { type?: string; media_type?: string; data?: string }
          }
          const url = base64ImageUrl(imgBlock.source ?? {})
          if (url) {
            parts.push({ type: 'image_url', image_url: { url } })
          }
        } else if (block.type === 'document') {
          const text = extractDocumentText(block as unknown as {
            source?: { type?: string; data?: unknown }
          })
          if (text) {
            parts.push({ type: 'text', text })
          }
        } else if (block.type === 'tool_result') {
          const trBlock = block as {
            type: 'tool_result'
            tool_use_id: string
            content: unknown
          }
          toolResults.push({
            role: 'tool',
            content: normalizeToolResultContent(trBlock.content),
            tool_call_id: trBlock.tool_use_id,
          })
        }
      }

      if (toolResults.length > 0) {
        result.push(...toolResults)
        // OpenAI 要求每条 tool 消息后紧跟一条 user 消息，缺了会 400。
        if (parts.length > 0) {
          result.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts })
        } else {
          result.push({ role: 'user', content: '' })
        }
      } else if (parts.length > 0) {
        result.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts })
      } else {
        // 空 content：保留占位，防止消息被静默丢弃破坏后续配对
        result.push({ role: 'user', content: '' })
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
      let reasoningContent: string | undefined

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push((block as { type: 'text'; text: string }).text)
        } else if (block.type === 'tool_use') {
          const tuBlock = block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          toolCalls.push({
            id: tuBlock.id,
            type: 'function',
            function: {
              name: tuBlock.name,
              arguments: JSON.stringify(tuBlock.input ?? {}),
            },
          })
        } else if (block.type === 'thinking') {
          const thinking = (block as { type: 'thinking'; thinking: string }).thinking
          reasoningContent = reasoningContent ? `${reasoningContent}\n${thinking}` : thinking
        }
        // redacted_thinking / server_tool_use 等无法映射的块忽略
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('\n') || null,
      }
      if (reasoningContent) {
        assistantMsg.reasoning_content = reasoningContent
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      pushMergedAssistant(result, assistantMsg)
    }
  }

  return result
}

export function convertAnthropicToolsToOpenAI(
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
): OpenAITool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

/**
 * 从 Anthropic 请求体估算 input tokens（chars/4，图片/文档按 2000 计，
 * 与 tokenEstimation.ts 的 roughTokenCountEstimationForBlock 保持一致）。
 * 用于替代 count_tokens stub 的 0 —— 0 会让 codev 的上下文预算/compact 全部失效。
 */
export function estimateTokensForAnthropicBody(body: {
  system?: unknown
  messages?: unknown
  tools?: unknown
}): number {
  let total = 0
  const roughCount = (text: string): number => Math.round(text.length / 4)

  if (typeof body.system === 'string') {
    total += roughCount(body.system)
  } else if (Array.isArray(body.system)) {
    for (const b of body.system) {
      if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
        total += roughCount((b as { text: string }).text)
      }
    }
  }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue
      const tool = t as { name?: unknown; description?: unknown; input_schema?: unknown }
      if (typeof tool.name === 'string') total += roughCount(tool.name)
      if (typeof tool.description === 'string') total += roughCount(tool.description)
      if (tool.input_schema !== undefined) {
        total += roughCount(JSON.stringify(tool.input_schema))
      }
    }
  }

  const countBlocks = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const b = block as {
        type?: unknown
        text?: unknown
        thinking?: unknown
        data?: unknown
        name?: unknown
        input?: unknown
        content?: unknown
      }
      switch (b.type) {
        case 'text':
          total += roughCount(typeof b.text === 'string' ? b.text : '')
          break
        case 'thinking':
          total += roughCount(typeof b.thinking === 'string' ? b.thinking : '')
          break
        case 'redacted_thinking':
          total += roughCount(typeof b.data === 'string' ? b.data : '')
          break
        case 'image':
        case 'document':
          total += 2000
          break
        case 'tool_use':
          total += roughCount(
            (typeof b.name === 'string' ? b.name : '') +
              JSON.stringify(b.input ?? {}),
          )
          break
        case 'tool_result':
          if (typeof b.content === 'string') {
            total += roughCount(b.content)
          } else if (Array.isArray(b.content)) {
            for (const c of b.content) {
              if (typeof c === 'string') {
                total += roughCount(c)
              } else if (c && typeof c === 'object') {
                const cc = c as { type?: unknown; text?: unknown; data?: unknown }
                if (cc.type === 'image' || cc.type === 'document') {
                  total += 2000
                } else if (typeof cc.text === 'string') {
                  total += roughCount(cc.text)
                }
              }
            }
          }
          break
        default:
          total += roughCount(JSON.stringify(b))
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue
      const m = msg as { content?: unknown }
      if (typeof m.content === 'string') {
        total += roughCount(m.content)
      } else {
        countBlocks(m.content)
      }
    }
  }

  return total
}

type OpenAIResponseShape = {
  id?: string
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id: string
        function: { name: string; arguments: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * 将 OpenAI 非流式响应转换为 Anthropic Messages 格式（含 thinking/reasoning
 * 与 tool_use），四个 provider 的 fetch override 共用。
 */
export function convertOpenAIResponseToAnthropic(
  data: OpenAIResponseShape,
  model: string,
  idPrefix: string,
): Record<string, unknown> {
  const choice = data.choices?.[0]
  const anthropicContent: Array<{
    type: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: unknown
  }> = []

  if (choice?.message?.reasoning_content) {
    anthropicContent.push({
      type: 'thinking',
      thinking: choice.message.reasoning_content,
    })
  }

  if (choice?.message?.content) {
    anthropicContent.push({ type: 'text', text: choice.message.content })
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: unknown = {}
      try {
        input = JSON.parse(tc.function.arguments || '{}')
      } catch {
        // 参数不是合法 JSON 时退化为空对象，避免整个响应解析失败
      }
      anthropicContent.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  return {
    id: data.id || `msg_${idPrefix}_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: anthropicContent,
    model,
    stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  }
}

/**
 * 把 OpenAI 错误响应（{error:{message,type}}）转换为 Anthropic SDK 能解析的
 * 错误格式（{"type":"error","error":{...}}），否则 SDK 解析失败导致错误信息错乱。
 */
export async function createAnthropicErrorResponse(
  openaiResponse: Response,
): Promise<Response> {
  let message = openaiResponse.statusText || 'Request failed'
  let type = 'api_error'
  try {
    const text = await openaiResponse.text()
    if (text) {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown; type?: unknown }
      }
      const err = parsed.error
      if (err) {
        if (typeof err.message === 'string' && err.message) {
          message = err.message
        }
        if (typeof err.type === 'string' && err.type) {
          type = err.type
        }
      }
    }
  } catch {
    // body 不是 JSON —— 保留默认 message
  }
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    {
      status: openaiResponse.status,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}


export type CopilotStreamEvent =
  | { type: 'message_start'; message: { id: string; type: 'message'; role: 'assistant'; model: string; content: []; usage: { input_tokens: number; output_tokens: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: string } | { type: 'thinking'; thinking: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage: { output_tokens: number } }
  | { type: 'message_stop' }

export async function* streamCopilotRequest(
  model: string,
  messages: AnthropicMessage[],
  systemPrompt: string | undefined,
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
  signal: AbortSignal,
): AsyncGenerator<CopilotStreamEvent> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) {
    throw new Error('GitHub Copilot is not connected. Use /connect to authenticate.')
  }

  const copilotModelId = getCopilotModelId(model)
  const openaiMessages = convertAnthropicMessagesToOpenAI(messages, systemPrompt)
  const openaiTools = tools.length > 0 ? convertAnthropicToolsToOpenAI(tools) : undefined
  const response = await sendCopilotChatCompletion({
    oauthToken: provider.oauthToken,
    modelId: copilotModelId,
    messages: openaiMessages,
    isStreaming: true,
    maxTokens: 16384,
    tools: openaiTools,
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error')
    throw new Error(`Copilot API error (${response.status}): ${errorText}`)
  }

  if (!response.body) {
    throw new Error('No response body from Copilot API')
  }

  const messageId = `msg_copilot_${Date.now()}`
  let contentIndex = 0
  let hasStartedContent = false
  let currentToolCallIndex = -1
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
  let totalOutputTokens = 0

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: copilotModelId,
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          if (hasStartedContent) {
            yield { type: 'content_block_stop', index: contentIndex }
            contentIndex++
            hasStartedContent = false
          }
          for (const [idx] of toolCalls) {
            yield {
              type: 'content_block_stop',
              index: contentIndex + idx,
            }
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: toolCalls.size > 0 ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: totalOutputTokens },
          }
          yield { type: 'message_stop' }
          return
        }

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null
              reasoning_content?: string | null
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
              role?: string
            }
            finish_reason?: string | null
          }>
          usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number }
        }

        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }

        if (chunk.usage?.completion_tokens) {
          totalOutputTokens = chunk.usage.completion_tokens
        }

        const choice = chunk.choices?.[0]
        if (!choice?.delta) continue

        const delta = choice.delta

        if (delta.reasoning_content != null && delta.reasoning_content !== '') {
          yield {
            type: 'content_block_start',
            index: contentIndex,
            content_block: { type: 'thinking', thinking: '' },
          }
          yield {
            type: 'content_block_delta',
            index: contentIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          }
          yield { type: 'content_block_stop', index: contentIndex }
          contentIndex++
        }

        if (delta.content != null && delta.content !== '') {
          if (!hasStartedContent) {
            hasStartedContent = true
            yield {
              type: 'content_block_start',
              index: contentIndex,
              content_block: { type: 'text', text: '' },
            }
          }
          yield {
            type: 'content_block_delta',
            index: contentIndex,
            delta: { type: 'text_delta', text: delta.content },
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              if (hasStartedContent && currentToolCallIndex === -1) {
                yield { type: 'content_block_stop', index: contentIndex }
                contentIndex++
                hasStartedContent = false
              }
              currentToolCallIndex = tc.index
              const toolBlockIndex = contentIndex + tc.index
              toolCalls.set(tc.index, {
                id: tc.id,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              })
              yield {
                type: 'content_block_start',
                index: toolBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function?.name || '',
                  input: {},
                },
              }
            } else if (tc.function?.arguments) {
              const existing = toolCalls.get(tc.index)
              if (existing) {
                existing.arguments += tc.function.arguments
                yield {
                  type: 'content_block_delta',
                  index: contentIndex + tc.index,
                  delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                }
              }
            }
          }
        }

        if (choice.finish_reason) {
          if (hasStartedContent) {
            yield { type: 'content_block_stop', index: contentIndex }
            contentIndex++
            hasStartedContent = false
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: totalOutputTokens },
          }
          yield { type: 'message_stop' }
          return
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (hasStartedContent) {
    yield { type: 'content_block_stop', index: contentIndex }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: totalOutputTokens },
  }
  yield { type: 'message_stop' }
}

export function createCopilotFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) {
    throw new Error('GitHub Copilot is not connected')
  }

  const copilotModelId = getCopilotModelId(model)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url

    const pathname = new URL(url).pathname
    // 只拦截 Messages 系列端点；精确判断避免误伤含 /v1/ 的其他请求
    const isMessagesPath =
      pathname.endsWith('/messages') || pathname.includes('/messages/')
    const isModelsPath = pathname.endsWith('/models')
    if (!isMessagesPath && !isModelsPath) {
      return fetch(input, init)
    }

    if (isModelsPath) {
      return new Response(JSON.stringify({ input_tokens: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let anthropicBody: Record<string, unknown> = {}
    if (init?.body) {
      try {
        anthropicBody = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer))
      } catch {
        return fetch(input, init)
      }
    }

    // count_tokens：本地估算，替代 0（0 会让上下文预算/compact 失效）
    if (pathname.endsWith('/count_tokens')) {
      return new Response(
        JSON.stringify({
          input_tokens: estimateTokensForAnthropicBody(anthropicBody),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const systemBlocks = anthropicBody.system as Array<{ type: string; text: string }> | string | undefined
    let systemPrompt = ''
    if (typeof systemBlocks === 'string') {
      systemPrompt = systemBlocks
    } else if (Array.isArray(systemBlocks)) {
      systemPrompt = systemBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n\n')
    }

    const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
    const openaiMessages = convertAnthropicMessagesToOpenAI(anthropicMessages, systemPrompt)

    const anthropicTools = (anthropicBody.tools || []) as Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
    const openaiTools = anthropicTools.length > 0 ? convertAnthropicToolsToOpenAI(anthropicTools) : undefined

    const isStreaming = anthropicBody.stream === true
    const maxTokens =
      typeof anthropicBody.max_tokens === 'number'
        ? anthropicBody.max_tokens
        : undefined

    const copilotResponse = await sendCopilotChatCompletion({
      oauthToken: provider.oauthToken,
      modelId: copilotModelId,
      messages: openaiMessages,
      isStreaming,
      maxTokens,
      tools: openaiTools,
      signal: init?.signal,
    })

    if (!copilotResponse.ok) {
      return createAnthropicErrorResponse(copilotResponse)
    }

    if (!isStreaming) {
      const data = (await copilotResponse.json()) as {
        id?: string
        choices?: Array<{
          message?: {
            content?: string | null
            reasoning_content?: string | null
            tool_calls?: Array<{
              id: string
              function: { name: string; arguments: string }
            }>
          }
          finish_reason?: string | null
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      const anthropicResponse = convertOpenAIResponseToAnthropic(
        data,
        copilotModelId,
        'copilot',
      )

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const transformStream = convertOpenAIStreamToAnthropic(copilotResponse.body!, copilotModelId)

    return new Response(transformStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}

/**
 * 将 OpenAI 兼容的 SSE 流转换为 Anthropic Messages 流式事件。
 *
 * 修复点（相对旧实现）：
 * - 发送 message_start（客户端在 content_block_stop 时要求 partialMessage 非空）
 * - tool_use 的 content_block_start 用正确的 tool_use 类型
 * - tool 参数增量以 input_json_delta 转发（否则客户端 tool_use.input 永远为空）
 * - 支持 reasoning_content → thinking 块
 * - 索引追踪修正（text/thinking 块在关闭时递增，tool 块用 contentIndex + 序号）
 * - usage 统计支持流末的 usage chunk（需配合 stream_options.include_usage）
 */
export function convertOpenAIStreamToAnthropic(
  openaiStream: ReadableStream,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const messageId = `msg_${Date.now()}`
  // 下一个可用的 Anthropic content block index；块在 start 时占用、关闭时递增
  let contentIndex = 0
  let hasStartedContent = false
  let hasReasoningBlock = false
  let hasSentMessageStart = false
  let currentToolCallIndex = -1
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
  let totalOutputTokens = 0
  let inputTokens = 0

  // JSON.stringify 会把换行等转义成反斜杠序列（无真实换行字节），
  // 因此嵌入 SSE data 行是安全的；slice(1,-1) 去掉引号得到 JSON 字符串字面量。
  const jsonEscape = (s: string): string => JSON.stringify(s).slice(1, -1)

  function sendMessageStart(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    if (hasSentMessageStart) return
    hasSentMessageStart = true
    controller.enqueue(
      encoder.encode(
        `event: message_start\ndata: {"type":"message_start","message":{"id":"${messageId}","type":"message","role":"assistant","content":[],"model":"${model}","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inputTokens},"output_tokens":0}}}\n\n`,
      ),
    )
  }

  function closeTextBlock(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    if (!hasStartedContent) return
    controller.enqueue(
      encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex}}\n\n`),
    )
    contentIndex++
    hasStartedContent = false
  }

  function closeReasoningBlock(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    if (!hasReasoningBlock) return
    controller.enqueue(
      encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex}}\n\n`),
    )
    contentIndex++
    hasReasoningBlock = false
  }

  function sendStreamEnd(
    controller: ReadableStreamDefaultController<Uint8Array>,
    stopReason?: string,
  ): void {
    if (!hasSentMessageStart) return
    closeTextBlock(controller)
    closeReasoningBlock(controller)
    for (const [idx] of toolCalls) {
      controller.enqueue(
        encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex + idx}}\n\n`),
      )
    }
    controller.enqueue(
      encoder.encode(
        `event: message_delta\ndata: {"delta":{"stop_reason":"${stopReason || (toolCalls.size > 0 ? 'tool_use' : 'end_turn')}"},"usage":{"output_tokens":${totalOutputTokens}}}\n\n`,
      ),
    )
    controller.enqueue(encoder.encode('event: message_stop\ndata: {}\n\n'))
  }

  return new ReadableStream({
    async start(controller) {
      const reader = openaiStream.getReader()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              sendStreamEnd(controller)
              return
            }

            let chunk: {
              choices?: Array<{
                delta?: {
                  content?: string | null
                  reasoning_content?: string | null
                  tool_calls?: Array<{
                    index: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }>
                  role?: string
                }
                finish_reason?: string | null
              }>
              usage?: {
                completion_tokens?: number
                prompt_tokens?: number
                total_tokens?: number
              }
            }

            try {
              chunk = JSON.parse(data)
            } catch {
              continue
            }

            // usage 可出现在任意 chunk（include_usage 时通常紧跟流末）
            if (chunk.usage?.prompt_tokens) {
              inputTokens = chunk.usage.prompt_tokens
            }
            if (chunk.usage?.completion_tokens) {
              totalOutputTokens = chunk.usage.completion_tokens
            }

            sendMessageStart(controller)

            const choice = chunk.choices?.[0]
            if (!choice?.delta) continue

            const delta = choice.delta

            // reasoning_content → thinking 块
            if (delta.reasoning_content != null && delta.reasoning_content !== '') {
              if (!hasReasoningBlock) {
                hasReasoningBlock = true
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_start\ndata: {"index":${contentIndex},"content_block":{"type":"thinking","thinking":""}}\n\n`,
                  ),
                )
              }
              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: {"index":${contentIndex},"delta":{"type":"thinking_delta","thinking":"${jsonEscape(delta.reasoning_content)}"}}\n\n`,
                ),
              )
            }

            // content → text 块
            if (delta.content != null && delta.content !== '') {
              if (!hasStartedContent) {
                hasStartedContent = true
                closeReasoningBlock(controller)
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_start\ndata: {"index":${contentIndex},"content_block":{"type":"text","text":""}}\n\n`,
                  ),
                )
              }
              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: {"index":${contentIndex},"delta":{"type":"text_delta","text":"${jsonEscape(delta.content)}"}}\n\n`,
                ),
              )
            }

            // tool_calls → tool_use 块
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  // 新 tool call：关闭当前 text 块（仅第一个 tool call 时）
                  if (hasStartedContent && currentToolCallIndex === -1) {
                    closeTextBlock(controller)
                  }
                  currentToolCallIndex = tc.index
                  const toolBlockIndex = contentIndex + tc.index
                  toolCalls.set(tc.index, {
                    id: tc.id,
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  })
                  controller.enqueue(
                    encoder.encode(
                      `event: content_block_start\ndata: {"index":${toolBlockIndex},"content_block":{"type":"tool_use","id":"${tc.id}","name":"${tc.function?.name || ''}","input":{}}}\n\n`,
                    ),
                  )
                } else if (tc.function?.arguments) {
                  const existing = toolCalls.get(tc.index)
                  if (existing) {
                    existing.arguments += tc.function.arguments
                    // 参数增量必须以 input_json_delta 转发，否则客户端累积不到工具参数
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: {"index":${contentIndex + tc.index},"delta":{"type":"input_json_delta","partial_json":"${jsonEscape(tc.function.arguments)}"}}\n\n`,
                      ),
                    )
                  }
                }
              }
            }

            if (choice.finish_reason) {
              sendStreamEnd(
                controller,
                choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
              )
              return
            }
          }
        }
        // 流自然结束（provider 未发 [DONE]）
        sendStreamEnd(controller)
      } finally {
        // 兜底：若流在 message_start 前就结束（异常/空流），补发最小序列，
        // 否则客户端 content_block_stop 时找不到 partialMessage 会抛错。
        try {
          if (!hasSentMessageStart) {
            sendMessageStart(controller)
            controller.enqueue(
              encoder.encode(
                'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
              ),
            )
            controller.enqueue(encoder.encode('event: message_stop\ndata: {}\n\n'))
          }
        } catch {
          // controller 可能已 error/closed
        }
        reader.releaseLock()
        controller.close()
      }
    },
  })
}