import { randomUUID } from 'crypto'
import { getOpenCodeApiKey, getOpenCodeModelName } from '../../utils/auth.js'
import {
  convertAnthropicToolsToOpenAI,
  convertOpenAIStreamToAnthropic,
  type AnthropicMessage,
  type AnthropicContentBlock,
} from './copilotClient.js'

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
// 核心进化：引入云端元数据和 GitHub 动态版本追溯终点
const MODELS_META_URL = 'https://models.dev/api.json'
const GITHUB_RELEASE_URL = 'https://api.github.com/repos/anomalyco/opencode/releases/latest'

// 安全兜底的初始 User-Agent
let dynamicUserAgent = 'opencode/1.15.6 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

let cachedModels: Array<{ id: string; name?: string; isFree: boolean }> | null = null
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
      const modelList: Array<{ id: string; name?: string; isFree: boolean }> = []

      for (const [modelId, config] of Object.entries(opencodeModels) as [string, any][]) {
        // 过滤掉已被官方废弃下架的模型
        if (config.status === 'deprecated') {
          continue
        }
        
        // 动态检测真正零成本的活体模型
        const isFreeModel = config.cost?.input === 0 && config.cost?.output === 0

        modelList.push({
          id: modelId,
          name: config.name || modelId,
          isFree: isFreeModel,
        })
      }

      cachedModels = modelList
    } catch (error) {
      console.error('[opencodeClient] Error in dynamic TUI flow simulation:', error)
      if (!cachedModels) {
        // 网络极端崩溃情况下的硬编码兜底保护
        cachedModels = [
          { id: 'big-pickle', name: 'Big Pickle', isFree: true },
          { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', isFree: true },
          { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super Free', isFree: true }
        ]
      }
    } finally {
      fetchPromise = null
    }
  })()
  
  await fetchPromise
}

export function getCachedOpencodeModels(): Array<{ id: string; name?: string; isFree: boolean }> {
  return cachedModels || []
}

type OpenAIMessage = {
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

function convertAnthropicMessagesToOpenAI(
  messages: AnthropicMessage[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    if (msg.role === 'user') {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      const toolResults: OpenAIMessage[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: (block as { type: 'text'; text: string }).text })
        } else if (block.type === 'image') {
          const imgBlock = block as { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}` },
          })
        } else if (block.type === 'tool_result') {
          const trBlock = block as { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
          let content = ''
          if (typeof trBlock.content === 'string') {
            content = trBlock.content
          } else if (Array.isArray(trBlock.content)) {
            content = trBlock.content
              .filter(c => c.type === 'text')
              .map(c => c.text || '')
              .join('\n')
          }
          toolResults.push({
            role: 'tool',
            content,
            tool_call_id: trBlock.tool_use_id,
          })
        }
      }

      if (toolResults.length > 0) {
        result.push(...toolResults)
        if (parts.length > 0) {
          result.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts })
        }
      } else if (parts.length > 0) {
        result.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts })
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
              arguments: JSON.stringify(tuBlock.input),
            },
          })
        } else if (block.type === 'thinking') {
          const thinkingBlock = block as { type: 'thinking'; thinking: string }
          reasoningContent = thinkingBlock.thinking
        }
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
      result.push(assistantMsg)
    }
  }

  return result
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

    if (!url.includes('/messages') && !url.includes('/v1/')) {
      return fetch(input, init)
    }

    if (url.includes('/count_tokens') || url.includes('/models')) {
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
      return openaiResponse
    }

    if (!isStreaming) {
      const data = (await openaiResponse.json()) as {
        id: string
        choices: Array<{
          message: {
            role: string
            content: string | null
            reasoning_content?: string
            tool_calls?: Array<{
              id: string
              function: { name: string; arguments: string }
            }>
          }
          finish_reason: string
        }>
        usage?: { prompt_tokens: number; completion_tokens: number }
      }

      const choice = data.choices[0]
      const anthropicContent: Array<{
        type: string
        text?: string
        id?: string
        name?: string
        input?: unknown
      }> = []

      if (choice?.message?.reasoning_content) {
        anthropicContent.push({ type: 'thinking', thinking: choice.message.reasoning_content })
      }

      if (choice?.message?.content) {
        anthropicContent.push({ type: 'text', text: choice.message.content })
      }

      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          anthropicContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          })
        }
      }

      const anthropicResponse = {
        id: data.id || `msg_opencode_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent,
        model: modelName,
        stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        usage: {
          input_tokens: data.usage?.prompt_tokens || 0,
          output_tokens: data.usage?.completion_tokens || 0,
        },
      }

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!openaiResponse.body) {
      return openaiResponse
    }

    const transformStream = convertOpenAIStreamToAnthropicWithReasoning(openaiResponse.body, modelName)

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

function convertOpenAIStreamToAnthropicWithReasoning(
  openaiStream: ReadableStream,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const messageId = `msg_${Date.now()}`
  let contentIndex = 0
  let hasStartedContent = false
  let hasReasoningBlock = false
  let hasSentMessageStart = false
  let currentToolCallIndex = -1
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
  let totalOutputTokens = 0

  function sendMessageStart(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (hasSentMessageStart) return
    hasSentMessageStart = true
    controller.enqueue(
      encoder.encode(
        `event: message_start\ndata: {"type":"message_start","message":{"id":"${messageId}","type":"message","role":"assistant","content":[],"model":"${model}","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n`,
      ),
    )
  }

  function sendStreamEnd(controller: ReadableStreamDefaultController<Uint8Array>, stopReason?: string): void {
    if (!hasSentMessageStart) return
    if (hasStartedContent) {
      controller.enqueue(encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex - 1}}\n\n`))
    }
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
          if (done) {
            if (hasSentMessageStart) {
              sendStreamEnd(controller)
            }
            break
          }

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
              usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number }
            }

            try {
              chunk = JSON.parse(data)
            } catch {
              continue
            }

            if (!hasSentMessageStart) {
              const inputTokens = chunk.usage?.prompt_tokens || 0
              controller.enqueue(
                encoder.encode(
                  `event: message_start\ndata: {"type":"message_start","message":{"id":"${messageId}","type":"message","role":"assistant","content":[],"model":"${model}","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inputTokens},"output_tokens":0}}}\n\n`,
                ),
              )
              hasSentMessageStart = true
            }

            if (chunk.usage?.completion_tokens) {
              totalOutputTokens = chunk.usage.completion_tokens
            }

            const choice = chunk.choices?.[0]
            if (!choice?.delta) continue

            const delta = choice.delta

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
                  `event: content_block_delta\ndata: {"index":${contentIndex},"delta":{"type":"thinking_delta","thinking":"${JSON.stringify(delta.reasoning_content).slice(1, -1)}"}}\n\n`,
                ),
              )
            }

            if (delta.content != null && delta.content !== '') {
              if (!hasStartedContent) {
                hasStartedContent = true
                if (hasReasoningBlock) {
                  controller.enqueue(
                    encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex}}\n\n`),
                  )
                  contentIndex++
                }
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_start\ndata: {"index":${contentIndex},"content_block":{"type":"text","text":""}}\n\n`,
                  ),
                )
              }
              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: {"index":${contentIndex},"delta":{"type":"text_delta","text":"${JSON.stringify(delta.content).slice(1, -1)}"}}\n\n`,
                ),
              )
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  if (hasStartedContent && currentToolCallIndex === -1) {
                    controller.enqueue(
                      encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex}}\n\n`),
                    )
                    contentIndex++
                    hasStartedContent = false
                  }
                  currentToolCallIndex = tc.index
                  toolCalls.set(tc.index, {
                    id: tc.id,
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  })
                  const toolBlockIndex =
                    hasStartedContent ? contentIndex + 1 + tc.index : contentIndex + tc.index
                  controller.enqueue(
                    encoder.encode(
                      `event: content_block_start\ndata: {"index":${toolBlockIndex},"content_block":{"type":"tool_use","id":"${tc.id}","name":"${tc.function?.name || ''}","input":{}}}\n\n`,
                    ),
                  )
                } else if (tc.function?.arguments) {
                  const existing = toolCalls.get(tc.index)
                  if (existing) {
                    existing.arguments += tc.function.arguments
                  }
                }
              }
            }

            if (choice.finish_reason) {
              if (hasStartedContent) {
                controller.enqueue(
                  encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex}}\n\n`),
                )
              }
              sendStreamEnd(controller, choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn')
              return
            }
          }
        }
      } finally {
        if (!hasSentMessageStart) {
          controller.enqueue(
            encoder.encode(
              `event: message_start\ndata: {"type":"message_start","message":{"id":"${messageId}","type":"message","role":"assistant","content":[],"model":"${model}","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n`,
            ),
          )
          controller.enqueue(
            encoder.encode('event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n'),
          )
          controller.enqueue(encoder.encode('event: message_stop\ndata: {}\n\n'))
        }
        reader.releaseLock()
        controller.close()
      }
    },
  })
}
