import { getOpenCodeApiKey, getOpenCodeModelName } from '../../utils/auth.js'
import {
  convertAnthropicToolsToOpenAI,
  convertOpenAIStreamToAnthropic,
  type AnthropicMessage,
  type AnthropicContentBlock,
} from './copilotClient.js'

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'

// Known free models that don't have -free suffix
const FREE_MODEL_IDS = new Set([
  'big-pickle',
  'gpt-5-nano',
])

let cachedModels: Array<{ id: string; name?: string; isFree: boolean }> | null = null
let fetchPromise: Promise<void> | null = null

export async function fetchOpencodeModels(): Promise<void> {
  if (fetchPromise) return
  
  fetchPromise = (async () => {
    try {
      const apiKey = getOpenCodeApiKey()
      const headers: Record<string, string> = {
        'User-Agent': 'claude-code/2.1.88',
      }
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`
      }

      const res = await fetch(`${OPENCODE_BASE_URL}/models`, { headers })
      if (!res.ok) return

      const data = await res.json() as { data?: Array<{ id: string; name?: string }> }
      if (Array.isArray(data.data)) {
        cachedModels = data.data.map(m => ({
          id: m.id,
          name: m.name || m.id,
          isFree: m.id.endsWith('-free') || FREE_MODEL_IDS.has(m.id),
        }))
      }
    } catch {
      // Ignore errors
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
  const apiKey = getOpenCodeApiKey() || ''
  const modelName = getOpenCodeModelName() || model || 'big-pickle'
  const endpoint = chatCompletionsUrl(apiKey ? OPENCODE_BASE_URL : OPENCODE_BASE_URL)

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

  let messageId = `msg_${Date.now()}`
  let contentIndex = 0
  let hasStartedContent = false
  let hasReasoningBlock = false
  let currentToolCallIndex = -1
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
  let totalOutputTokens = 0

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
              if (hasStartedContent) {
                controller.enqueue(encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex - 1}}\n\n`))
              }
              for (const [idx, tc] of toolCalls) {
                controller.enqueue(
                  encoder.encode(`event: content_block_stop\ndata: {"index":${contentIndex + idx}}\n\n`),
                )
              }
              controller.enqueue(
                encoder.encode(
                  `event: message_delta\ndata: {"delta":{"stop_reason":"${toolCalls.size > 0 ? 'tool_use' : 'end_turn'}"},"usage":{"output_tokens":${totalOutputTokens}}}\n\n`,
                ),
              )
              controller.enqueue(encoder.encode('event: message_stop\ndata: {}\n\n'))
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
                      `event: content_block_start\ndata: {"index":${toolBlockIndex},"content_block":{"type":"text","text":""}}\n\n`,
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
              controller.enqueue(
                encoder.encode(
                  `event: message_delta\ndata: {"delta":{"stop_reason":"${choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn'}"},"usage":{"output_tokens":${totalOutputTokens}}}\n\n`,
                ),
              )
              controller.enqueue(encoder.encode('event: message_stop\ndata: {}\n\n'))
              return
            }
          }
        }
      } finally {
        reader.releaseLock()
        controller.close()
      }
    },
  })
}
