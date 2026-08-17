/**
 * OpenAI 兼容 endpoint 的 fetch override —— codev 的 OpenAI 真直连。
 *
 * 通过 OPENAI_API_KEY（可选，本地端点可缺省）+ OPENAI_BASE_URL 直连任意
 * OpenAI Chat Completions 协议端点（OpenAI 官方、DeepSeek、vLLM、Ollama 等）。
 *
 * 拦截 Anthropic Messages API 调用，复用 @ant/model-provider 的完整转换管线
 * 转成 OpenAI 格式，再把响应（含 reasoning_content → thinking 思维流）转回
 * Anthropic 格式，下游 SDK/query 管线完全无感。
 */
import { getOpenAIApiKey } from 'src/utils/auth.js'
import {
  getOpenAIBaseUrl,
} from 'src/utils/model/providers.js'
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
} from './requestBody.js'
import { getOfficialOpenAIPromptCacheKey } from './openaiShared.js'

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

/** Supports `https://host` or `https://host/v1` style bases. */
export function chatCompletionsUrl(base: string): string {
  const b = normalizeBaseUrl(base)
  if (b.endsWith('/v1')) {
    return `${b}/chat/completions`
  }
  return `${b}/v1/chat/completions`
}

/**
 * 创建 OpenAI 兼容端点的 fetch override（env 直连版）。
 *
 * @param model 已解析的 OpenAI 模型名（客户端侧 resolveOpenAIModel 的产物）
 */
export function createOpenAIFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const baseUrl = getOpenAIBaseUrl()
  const apiKey = getOpenAIApiKey()
  const resolvedModel = model || DEFAULT_OPENAI_MODEL
  const endpoint = chatCompletionsUrl(baseUrl)

  const useOfficialCache = getOfficialOpenAIPromptCacheKey(
    baseUrl,
    getSessionId(),
  )

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
          typeof init.body === 'string'
            ? init.body
            : new TextDecoder().decode(init.body as ArrayBuffer),
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
    // models.dev 判定（带缓存），纯文本模型丢弃历史图片而不是发 image_url
    const supportsImages = await resolveOpenAIModelSupportsImages(resolvedModel)
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
    const openaiTools =
      anthropicTools.length > 0
        ? convertAnthropicToolsToOpenAI(anthropicTools)
        : undefined

    const isStreaming = anthropicBody.stream === true
    const enableThinking = isOpenAIThinkingEnabled(resolvedModel)
    const maxTokens = resolveOpenAIMaxTokens(
      getModelMaxOutputTokens(resolvedModel).upperLimit,
    )

    const requestBody = buildOpenAIRequestBody({
      model: resolvedModel,
      messages: openaiMessages,
      tools: openaiTools,
      toolChoice: openaiTools && openaiTools.length > 0 ? 'auto' : undefined,
      enableThinking,
      maxTokens,
      promptCacheKey: useOfficialCache,
    })
    if (!isStreaming) {
      requestBody.stream = false
      delete requestBody.stream_options
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.88',
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
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
        resolvedModel,
        'openai',
      )

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!openaiResponse.body) {
      return openaiResponse
    }

    const transformStream = convertOpenAIStreamToAnthropic(
      openaiResponse.body,
      resolvedModel,
      { includeCacheWriteTokens: !!useOfficialCache },
    )

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