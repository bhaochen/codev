import { getNvidiaApiKey } from '../../utils/auth.js'
import { getNvidiaBaseUrl } from '../../utils/model/providers.js'
import {
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  convertOpenAIResponseToAnthropic,
  convertOpenAIStreamToAnthropic,
  createAnthropicErrorResponse,
  estimateTokensForAnthropicBody,
  resolveOpenAIModelSupportsImages,
  type AnthropicMessage,
} from '@ant/model-provider'

const MODELS_META_URL = 'https://models.dev/api.json'

type CachedNvidiaModel = {
  id: string
  contextWindow?: number
  maxTokens?: number
  reasoningOptions?: string[]
}

/**
 * NVIDIA NIM API uses the OpenAI-compatible `/v1/chat/completions` protocol.
 * This fetch override intercepts Anthropic Messages API calls and translates
 * them to the OpenAI format that NVIDIA expects.
 */

const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function chatCompletionsUrl(base: string): string {
  const b = normalizeBaseUrl(base)
  if (b.endsWith('/v1')) {
    return `${b}/chat/completions`
  }
  return `${b}/v1/chat/completions`
}

export function createNvidiaFetchOverride(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const baseUrl = getNvidiaBaseUrl()
  const apiKey = getNvidiaApiKey()
  const endpoint = chatCompletionsUrl(baseUrl)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url

    const pathname = new URL(url).pathname
    // Only intercept Messages API calls — precise path matching avoids
    // swallowing unrelated requests that happen to contain /v1/
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
        anthropicBody = JSON.parse(
          typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer),
        )
      } catch {
        return fetch(input, init)
      }
    }

    // count_tokens: local estimate instead of 0 (0 breaks context budgeting/compact)
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

    const systemBlocks = anthropicBody.system as
      | Array<{ type: string; text: string }>
      | string
      | undefined
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
    const selectedModel = (anthropicBody.model as string) || NVIDIA_MODEL
    // models.dev 判定（带缓存），纯文本模型丢弃历史图片而不是发 image_url
    const supportsImages = await resolveOpenAIModelSupportsImages(selectedModel)
    const openaiMessages = convertAnthropicMessagesToOpenAI(
      anthropicMessages,
      systemPrompt,
      { supportsImages },
    )

    const anthropicTools = (anthropicBody.tools || []) as Array<{
      name: string
      description?: string
      input_schema?: Record<string, unknown>
    }>
    const openaiTools = anthropicTools.length > 0 ? convertAnthropicToolsToOpenAI(anthropicTools) : undefined

    const isStreaming = anthropicBody.stream === true

    const requestBody: Record<string, unknown> = {
      model: selectedModel,
      messages: openaiMessages,
      stream: isStreaming,
    }

    // Ask the server to return a usage chunk in streaming mode, otherwise
    // output token accounting is always 0
    if (isStreaming) {
      requestBody.stream_options = { include_usage: true }
    }

    if (anthropicBody.max_tokens) {
      requestBody.max_tokens = anthropicBody.max_tokens
    }

    if (openaiTools && openaiTools.length > 0) {
      requestBody.tools = openaiTools
      requestBody.tool_choice = 'auto'
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.88',
      'HTTP-Referer': 'https://claude.ai/',
      'X-Title': 'Better-Clawd',
      'X-BILLING-INVOKE-ORIGIN': 'Better-Clawd',
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    const nvidiaResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: init?.signal,
    })

    if (!nvidiaResponse.ok) {
      return createAnthropicErrorResponse(nvidiaResponse)
    }

    if (!isStreaming) {
      const data = (await nvidiaResponse.json()) as {
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
        selectedModel,
        'nvidia',
      )

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Streaming response
    if (!nvidiaResponse.body) {
      return nvidiaResponse
    }

    const transformStream = convertOpenAIStreamToAnthropic(nvidiaResponse.body, selectedModel)

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

let cachedNvidiaModels: CachedNvidiaModel[] | null = null
let fetchPromise: Promise<string[]> | null = null

export function getCachedNvidiaModels(): CachedNvidiaModel[] {
  return cachedNvidiaModels || []
}

export function getNvidiaModelContextWindow(modelId: string): number | undefined {
  if (!cachedNvidiaModels) return undefined
  const model = cachedNvidiaModels.find(m => m.id === modelId)
  return model?.contextWindow
}

export function getNvidiaModelReasoningOptions(modelId: string): string[] | undefined {
  if (!cachedNvidiaModels) return undefined
  const model = cachedNvidiaModels.find(m => m.id === modelId)
  return model?.reasoningOptions
}

/**
 * Fetch available models from the NVIDIA API catalog and merge context windows
 * from the models.dev API (which provides limit.context for 74/84 NVIDIA models).
 */
export async function fetchNvidiaModels(apiKey?: string): Promise<string[]> {
  if (fetchPromise) return []
  fetchPromise = (async () => {
    const baseUrl = getNvidiaBaseUrl()
    const key = apiKey || getNvidiaApiKey()
    const normalizedBase = normalizeBaseUrl(baseUrl)
    const modelsUrl = normalizedBase.endsWith('/v1')
      ? `${normalizedBase}/models`
      : `${normalizedBase}/v1/models`

    const headers: Record<string, string> = {}
    if (key) {
      headers.Authorization = `Bearer ${key}`
    }

    // Fetch NVIDIA model IDs from the provider's own API
    // Note: this API only returns { id, object, created, owned_by } — no context window
    let modelIds: string[] = []
    try {
      const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(20_000) })
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ id: string }> }
        if (json.data && Array.isArray(json.data)) {
          modelIds = json.data.map((m: { id: string }) => m.id)
        }
      }
    } catch {
      // NVIDIA API unreachable — still try models.dev fallback below
    }

    // Fetch context windows from models.dev API (canonical source for context limits)
    const contextWindows = new Map<string, { contextWindow?: number; maxTokens?: number; reasoningOptions?: string[] }>()
    try {
      const metaRes = await fetch(MODELS_META_URL, {
        headers: { 'User-Agent': 'opencode/1.15.6 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14' },
        signal: AbortSignal.timeout(15_000),
      })
      if (metaRes.ok) {
        const data = (await metaRes.json()) as any
        const nvidiaModels = data?.nvidia?.models || {}
        for (const [modelId, config] of Object.entries(nvidiaModels) as [string, any][]) {
          const reasoningOptions = config.reasoning_options?.find(
            (o: any) => o.type === 'effort',
          )?.values
          contextWindows.set(modelId, {
            contextWindow: config.limit?.context,
            maxTokens: config.limit?.output,
            reasoningOptions,
          })
        }
      }
    } catch {
      // models.dev unreachable — models will use fallback defaults
    }

    // Merge: model IDs from NVIDIA API + context windows from models.dev
    // If NVIDIA API call failed, fall back to the full model list from models.dev
    if (modelIds.length === 0) {
      modelIds = [...contextWindows.keys()]
    }

    cachedNvidiaModels = modelIds.map(id => ({
      id,
      contextWindow: contextWindows.get(id)?.contextWindow,
      maxTokens: contextWindows.get(id)?.maxTokens,
      reasoningOptions: contextWindows.get(id)?.reasoningOptions,
    }))

    return modelIds
  })()
  await fetchPromise
  return cachedNvidiaModels?.map(m => m.id) || []
}
