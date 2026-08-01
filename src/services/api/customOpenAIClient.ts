import { getGlobalConfig, type ConnectedProviderInfo } from '../../utils/config.js'
import {
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  convertOpenAIResponseToAnthropic,
  convertOpenAIStreamToAnthropic,
  createAnthropicErrorResponse,
  estimateTokensForAnthropicBody,
  type AnthropicMessage,
} from './copilotClient.js'

const PREFIX = 'custom-openai:'

export function isCustomOpenAIModel(model: string | undefined): boolean {
  return !!model?.startsWith(PREFIX)
}

export function getCustomOpenAIModelId(model: string): string {
  const rest = model.slice(PREFIX.length).trim()
  if (rest) {
    return rest
  }
  const p = getGlobalConfig().connectedProviders?.['custom-openai']
  return p?.defaultModel || 'gpt-4o-mini'
}

export function getCustomOpenAIProvider(): ConnectedProviderInfo | undefined {
  return getGlobalConfig().connectedProviders?.['custom-openai']
}

export function isCustomOpenAIConnected(): boolean {
  const c = getGlobalConfig()
  return c.activeProvider === 'custom-openai' && !!c.connectedProviders?.['custom-openai']?.baseUrl
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

/** Supports `https://host` or `https://host/v1` style bases. */
function chatCompletionsUrl(base: string): string {
  const b = normalizeBaseUrl(base)
  if (b.endsWith('/v1')) {
    return `${b}/chat/completions`
  }
  return `${b}/v1/chat/completions`
}

/**
 * OpenAI-compatible `/v1/chat/completions` bridge (same protocol as GitHub Copilot path).
 */
export function createCustomOpenAIFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const provider = getCustomOpenAIProvider()
  if (!provider?.baseUrl) {
    throw new Error('Custom OpenAI-compatible API is not configured')
  }

  const openaiModelId = getCustomOpenAIModelId(model)
  const endpoint = chatCompletionsUrl(provider.baseUrl)

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
        anthropicBody = JSON.parse(
          typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer),
        )
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
    const openaiMessages = convertAnthropicMessagesToOpenAI(anthropicMessages, systemPrompt)

    const anthropicTools = (anthropicBody.tools || []) as Array<{
      name: string
      description?: string
      input_schema?: Record<string, unknown>
    }>
    const openaiTools = anthropicTools.length > 0 ? convertAnthropicToolsToOpenAI(anthropicTools) : undefined

    const isStreaming = anthropicBody.stream === true

    const requestBody: Record<string, unknown> = {
      model: openaiModelId,
      messages: openaiMessages,
      stream: isStreaming,
    }

    // 流式时让服务端回传 usage chunk，否则 output_tokens 统计恒为 0
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
    }
    if (provider.apiKey) {
      headers.Authorization = `Bearer ${provider.apiKey}`
    }

    const openaiResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: init?.signal,
    })

    if (!openaiResponse.ok) {
      return createAnthropicErrorResponse(openaiResponse)
    }

    if (!isStreaming) {
      const data = (await openaiResponse.json()) as {
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
        openaiModelId,
        'custom_openai',
      )

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!openaiResponse.body) {
      return openaiResponse
    }

    const transformStream = convertOpenAIStreamToAnthropic(openaiResponse.body, openaiModelId)

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

function modelsListUrlFromOpenAIBase(base: string): string {
  const b = normalizeBaseUrl(base)
  if (b.endsWith('/v1')) {
    return `${b}/models`
  }
  return `${b}/v1/models`
}

function parseOpenAIStyleModelList(json: unknown): string[] {
  if (!json || typeof json !== 'object') {
    return []
  }
  const o = json as Record<string, unknown>
  const data = o.data
  if (Array.isArray(data)) {
    const ids: string[] = []
    for (const item of data) {
      if (item && typeof item === 'object' && 'id' in item && typeof (item as { id: unknown }).id === 'string') {
        ids.push((item as { id: string }).id)
      }
    }
    return [...new Set(ids.filter(Boolean))]
  }
  const models = o.models
  if (Array.isArray(models)) {
    const ids: string[] = []
    for (const item of models) {
      if (typeof item === 'string') {
        ids.push(item)
      } else if (item && typeof item === 'object' && 'id' in item && typeof (item as { id: unknown }).id === 'string') {
        ids.push((item as { id: string }).id)
      }
    }
    return [...new Set(ids.filter(Boolean))]
  }
  return []
}

/**
 * GET /v1/models (OpenAI-compatible).
 */
export async function fetchOpenAICompatibleModelIds(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  const url = modelsListUrlFromOpenAIBase(baseUrl)
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI-compatible /v1/models failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const json: unknown = await res.json()
  const ids = parseOpenAIStyleModelList(json)
  return ids
}

/**
 * GET /v1/models (Anthropic API).
 */
export async function fetchAnthropicCompatibleModelIds(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  let root = baseUrl.replace(/\/$/, '')
  if (root.endsWith('/v1')) {
    root = root.slice(0, -3)
  }
  const url = `${root}/v1/models`
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  if (apiKey) {
    headers['x-api-key'] = apiKey
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic /v1/models failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const json: unknown = await res.json()
  const ids = parseOpenAIStyleModelList(json)
  return ids
}