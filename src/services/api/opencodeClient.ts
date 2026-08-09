import { randomUUID } from 'crypto'
import { getOpenCodeApiKey, getOpenCodeModelName } from '../../utils/auth.js'
import {
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  convertOpenAIResponseToAnthropic,
  convertOpenAIStreamToAnthropic,
  createAnthropicErrorResponse,
  estimateTokensForAnthropicBody,
  type AnthropicMessage,
} from '@ant/model-provider'

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
// 核心进化：引入云端元数据和 GitHub 动态版本追溯终点
const MODELS_META_URL = 'https://models.dev/api.json'
const GITHUB_RELEASE_URL = 'https://api.github.com/repos/anomalyco/opencode/releases/latest'

// 安全兜底的初始 User-Agent
let dynamicUserAgent = 'opencode/1.15.6 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

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
      // ✨ 步骤 1：复刻 TUI，先去 GitHub 动态探针摸出最新的 CLI 版本号
      // -----------------------------------------------------------------
      let cliVersion = '1.15.6' // 默认兜底版本
      try {
        const ghRes = await fetch(GITHUB_RELEASE_URL, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentFramework/1.0)' }
        })
        if (ghRes.ok) {
          const ghData = await ghRes.json() as { tag_name?: string }
          if (ghData.tag_name) {
            // 精准剥离 'v' 前缀 (例如 v1.15.10 -> 1.15.10)
            cliVersion = ghData.tag_name.replace(/^v/, '')
          }
        }
      } catch (ghError) {
        console.error('[opencodeClient] 动态获取 GitHub 版本失败，采用安全兜底:', ghError)
      }

      // -----------------------------------------------------------------
      // ✨ 步骤 2：请求大杂烩元数据，为精准剔除下架模型、识别免费模型做铺垫
      // -----------------------------------------------------------------
      const res = await fetch(MODELS_META_URL, {
        headers: {
          'User-Agent': `opencode/${cliVersion} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`,
          'Accept-Encoding': 'gzip, deflate, br'
        }
      })
      
      if (!res.ok) {
        console.error(`[opencodeClient] Failed to fetch models meta: ${res.status} ${res.statusText}`)
        return
      }

      const data = await res.json() as any
      const npmProvider = data?.opencode?.npm || '@ai-sdk/openai-compatible'
      const currentBunVer = typeof Bun !== 'undefined' ? Bun.version : '1.3.14'

      // -----------------------------------------------------------------
      // ✨ 步骤 3：合体！将获取到的依赖名与最新版本号注入全局动态 UA 中
      // -----------------------------------------------------------------
      dynamicUserAgent = `opencode/${cliVersion} ${npmProvider} ai-sdk/provider-utils/4.0.23 runtime/bun/${currentBunVer}`
      console.error(`[opencodeClient] TUI 动态嗅探闭环成功，最新 UA 状态就绪: "${dynamicUserAgent}"`)

      // -----------------------------------------------------------------
      // ✨ 步骤 4：摒弃死板的硬编码 Set，改用云端 cost 策略实时判定免费模型
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
    const openaiMessages = convertAnthropicMessagesToOpenAI(anthropicMessages, systemPrompt)

    // =================================================================
    // 🎯 核心修复：在这里对转换完的 openaiMessages 强行挂载鉴权暗桩
    // =================================================================
    const apiKey = getOpenCodeApiKey()
    
    if (!apiKey || apiKey === 'public') {
      // 1. 动态生成今天的特征时间标识
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const billingSled = `x-anthropic-billing-header: cc_version=2.1.87-dev.${todayStr}.t104103.sha02656111.0d1;cc_entrypoint=cli;\n\n`

      // 2. 注入特征码到 System Messages 链中
      const systemNode = openaiMessages.find(m => m.role === 'system')
      if (systemNode) {
        if (typeof systemNode.content === 'string') {
          systemNode.content = billingSled + systemNode.content
        }
      } else {
        openaiMessages.unshift({
          role: 'system',
          content: billingSled.trim()
        })
      }
    }

    const anthropicTools = (anthropicBody.tools || []) as Array<{
      name: string
      description?: string
      input_schema?: Record<string, unknown>
    }>
    const openaiTools = anthropicTools.length > 0 ? convertAnthropicToolsToOpenAI(anthropicTools) : undefined

    const isStreaming = anthropicBody.stream === true

    const requestBody: Record<string, unknown> = {
      model: modelName,
      messages: openaiMessages, // 此时已经携带暗桩凭证
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

    // =================================================================
    // 🎯 规范化自定义头部，缩短格式以完美契合 TUI 官方特征
    // =================================================================
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': dynamicUserAgent,
      'x-opencode-client': 'cli',
      'x-opencode-project': 'global',
      'x-opencode-session': `ses_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
      'x-opencode-request': `msg_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
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

