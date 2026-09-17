import { getOpenCodeApiKey, getOpenCodeModelName } from '../../utils/auth.js'
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
import { createOpencodeId, getOpencodeProjectId, getOpencodeUserAgent } from './opencodeUserAgent.js'

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
// 模型目录源与官方 opencode 对齐：优先自建镜像，失败回退上游 models.dev
// （对标 opencode packages/core/src/models-dev.ts: `Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"`）
const MODELS_META_PRIMARY_URL =
  process.env.OPENCODE_MODELS_URL || 'https://models.opencode.ai/api.json'
const MODELS_META_FALLBACK_URL = 'https://models.dev/api.json'

type CachedOpencodeModel = {
  id: string
  name?: string
  isFree: boolean
  contextWindow?: number
  maxTokens?: number
  reasoningOptions?: string[]
}

let cachedModels: CachedOpencodeModel[] | null = null
let fetchPromise: Promise<void> | null = null

export async function fetchOpencodeModels(): Promise<void> {
  if (fetchPromise) return
  
  fetchPromise = (async () => {
    try {
      // -----------------------------------------------------------------
      // 请求模型目录元数据，为精准剔除下架模型、识别免费模型做铺垫。
      // UA 必须对应本机安装的 OpenCode 版本，不能拿 GitHub 最新版本冒充。
      // 主源 models.opencode.ai（官方行为），失败回退 models.dev
      // -----------------------------------------------------------------
      const metaHeaders = {
        'User-Agent': getOpencodeUserAgent(),
        'Accept-Encoding': 'gzip, deflate, br',
      }
      let res = await fetch(MODELS_META_PRIMARY_URL, { headers: metaHeaders }).catch(() => null)
      if (!res?.ok) {
        console.error(
          `[opencodeClient] Primary models source failed (${res ? `${res.status} ${res.statusText}` : 'network error'}), falling back to ${MODELS_META_FALLBACK_URL}`,
        )
        res = await fetch(MODELS_META_FALLBACK_URL, { headers: metaHeaders }).catch(() => null)
      }

      if (!res?.ok) {
        console.error(`[opencodeClient] Failed to fetch models meta: ${res ? `${res.status} ${res.statusText}` : 'network error'}`)
        return
      }

      const data = await res.json() as any
      // -----------------------------------------------------------------
      // 摒弃死板的硬编码 Set，改用云端 cost 策略实时判定免费模型
      // -----------------------------------------------------------------
      const opencodeModels = data?.opencode?.models || {}
      const modelList: CachedOpencodeModel[] = []

      for (const [modelId, config] of Object.entries(opencodeModels) as [string, any][]) {
        // 过滤掉已被官方废弃下架的模型
        if (config.status === 'deprecated') {
          continue
        }
        
        // 动态检测真正零成本的活体模型
        const isFreeModel = config.cost?.input === 0 && config.cost?.output === 0
        const reasoningOptions = config.reasoning_options?.find(
          (o: any) => o.type === 'effort',
        )?.values

        modelList.push({
          id: modelId,
          name: config.name || modelId,
          isFree: isFreeModel,
          contextWindow: config.limit?.context,
          maxTokens: config.limit?.output,
          reasoningOptions,
        })
      }

      cachedModels = modelList
    } catch (error) {
      console.error('[opencodeClient] Error in dynamic TUI flow simulation:', error)
      if (!cachedModels) {
        // 网络极端崩溃情况下的硬编码兜底保护
        cachedModels = [
          { id: 'big-pickle', name: 'Big Pickle', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
          { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
          { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super Free', isFree: true, contextWindow: 200_000, maxTokens: 32_000 },
        ]
      }
    } finally {
      fetchPromise = null
    }
  })()
  
  await fetchPromise
}

export function getCachedOpencodeModels(): CachedOpencodeModel[] {
  return cachedModels || []
}

/**
 * 目录驱动的显示名：有缓存命中即返回目录 name，无硬编码 ID 分支；
 * 未命中返回 undefined，调用方自行回退原始 ID。
 */
export function getOpencodeModelDisplayName(modelId: string): string | undefined {
  if (!cachedModels) return undefined
  return cachedModels.find(m => m.id === modelId)?.name
}

export function getOpencodeModelContextWindow(modelId: string): number | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.contextWindow
}

export function getOpencodeModelMaxTokens(modelId: string): number | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.maxTokens
}

export function getOpencodeModelReasoningOptions(modelId: string): string[] | undefined {
  if (!cachedModels) return undefined
  const model = cachedModels.find(m => m.id === modelId)
  return model?.reasoningOptions
}

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

export function createOpenCodeFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const modelName = getOpenCodeModelName() || model || 'big-pickle'
  const endpoint = chatCompletionsUrl(OPENCODE_BASE_URL)

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
    // models.dev 判定（带缓存），纯文本模型丢弃历史图片而不是发 image_url
    const supportsImages = await resolveOpenAIModelSupportsImages(modelName)
    const openaiMessages = convertAnthropicMessagesToOpenAI(
      anthropicMessages,
      systemPrompt,
      { supportsImages },
    )

    const apiKey = getOpenCodeApiKey()

    const anthropicTools = (anthropicBody.tools || []) as Array<{
      name: string
      description?: string
      input_schema?: Record<string, unknown>
    }>
    const openaiTools = anthropicTools.length > 0 ? convertAnthropicToolsToOpenAI(anthropicTools) : undefined

    const isStreaming = anthropicBody.stream === true

    const requestBody: Record<string, unknown> = {
      model: modelName,
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
      requestBody.tool_choice =
        (anthropicBody as { tool_choice?: unknown }).tool_choice ?? 'auto'
    }

    // =================================================================
    // 🎯 规范化自定义头部，缩短格式以完美契合 TUI 官方特征
    // =================================================================
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getOpencodeUserAgent(),
      'x-opencode-client': 'cli',
      'x-opencode-project': await getOpencodeProjectId(),
      'x-opencode-session': createOpencodeId('ses'),
      'x-opencode-request': createOpencodeId('msg'),
      Authorization: `Bearer ${apiKey || 'public'}`,
    }

    const t0 = Date.now()
    const openaiResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: init?.signal,
    })
    const t1 = Date.now()
    console.error(`[opencodeClient] ${isStreaming ? 'stream' : 'non-stream'} fetch took ${t1 - t0}ms, status=${openaiResponse.status}`)

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
        modelName,
        'opencode',
      )

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!openaiResponse.body) {
      return openaiResponse
    }

    const transformStream = convertOpenAIStreamToAnthropic(openaiResponse.body, modelName)

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
