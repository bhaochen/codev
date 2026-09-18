/**
 * Minimal OpenAI fetch override for legacy api/client.ts OpenAI provider path.
 * Kept for active legacy consumer (api/client.ts) — not part of dead inference path.
 */
import { getOpenAIApiKey } from '../../../utils/auth.js'
import { getOpenAIBaseUrl } from '../../../utils/model/providers.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import { logForDebugging } from '../../../utils/debug.js'
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
import {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
} from '../../../services/llm/utils/requestBody.js'

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

function getOfficialOpenAIPromptCacheKey(baseURL: string | undefined, sessionId: string): string | undefined {
  if (!baseURL?.trim()) return `ccb:${sessionId}`
  try {
    const url = new URL(baseURL)
    const isOfficialHost = url.hostname === 'api.openai.com' || url.hostname.endsWith('.api.openai.com')
    if (url.protocol === 'https:' && isOfficialHost && (url.port === '' || url.port === '443')) {
      return `ccb:${sessionId}`
    }
  } catch {}
  return undefined
}

/**
 * Creates OpenAI-compatible endpoint fetch override (env direct-connect version).
 *
 * @param model Pre-resolved OpenAI model name (result of client-side resolveOpenAIModel)
 */
export function createOpenAIFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const baseUrl = getOpenAIBaseUrl()
  const apiKey = getOpenAIApiKey()
  const resolvedModel = model || 'gpt-4o-mini'
  const endpoint = chatCompletionsUrl(baseUrl)

  const useOfficialCache = getOfficialOpenAIPromptCacheKey(baseUrl, getSessionId())

  logForDebugging(
    `[OpenAI] direct override: model=${resolvedModel}, endpoint=${endpoint}, thinking=${isOpenAIThinkingEnabled(resolvedModel)}`,
  )

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      input instanceof URL
        ? input.href
        : typeof input === 'string'
          ? input
          : input.url

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
          typeof init.body === 'string'
            ? init.body
            : new TextDecoder().decode(init.body as ArrayBuffer),
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
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')
    }

    const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
    const selectedModel = (anthropicBody.model as string) || resolvedModel
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
      requestBody.tool_choice = anthropicBody.tool_choice ?? 'auto'
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.88',
      'HTTP-Referer': 'https://claude.ai/',
      'X-Title': 'Better-Clawd',
    }

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    if (useOfficialCache) {
      headers['prompt-cache-key'] = useOfficialCache
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: init?.signal,
    })

    if (!response.ok) {
      return createAnthropicErrorResponse(response, endpoint)
    }

    if (!isStreaming) {
      // Non-streaming: convert full response
      const json = await response.json()
      return new Response(
        JSON.stringify(convertOpenAIResponseToAnthropic(json)),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    // Streaming: convert chunk-by-chunk
    const stream = convertOpenAIStreamToAnthropic(response.body!, selectedModel)
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
}