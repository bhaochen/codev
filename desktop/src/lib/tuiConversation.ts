/**
 * TUI-style conversation module for desktop.
 *
 * Reuses TUI's approach of directly calling provider APIs via HTTP,
 * without going through the cc-haha sidecar or CLI subprocess.
 *
 * Supports all provider types:
 *  - Anthropic protocol: firstParty, openrouter, openai, local
 *  - OpenAI protocol: nvidia (NIM), opencode
 *
 * Config is read from ~/.claude.json via getTuiConfig().
 */

import { getTuiConfig } from '../api/config'

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ConversationStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'content_block_start'; index: number; blockType: string }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_stop'; usage?: { input_tokens?: number; output_tokens?: number } }
  | { type: 'error'; message: string }
  | { type: 'done' }

export type ConversationResult = {
  content: string
  usage?: { input_tokens: number; output_tokens: number }
}

// ─── Provider client factory ────────────────────────────────────────────────

type ProviderClientConfig = {
  baseUrl: string
  apiKey: string
  model: string
  /** Anthropic Messages API vs OpenAI Chat Completions */
  protocol: 'anthropic' | 'openai'
}

async function resolveProviderConfig(model?: string): Promise<ProviderClientConfig> {
  const config = await getTuiConfig()
  const authProvider = (config.authProvider as string) || 'anthropic'

  // Resolve API key and base URL based on provider
  switch (authProvider) {
    case 'openrouter': {
      const apiKey = config.openRouterApiKey as string
      if (!apiKey) throw new Error('OpenRouter API key not configured. Run /login first.')
      return {
        baseUrl: (process.env as Record<string, string>).OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        apiKey,
        model: model || 'anthropic/claude-sonnet-4-6',
        protocol: 'anthropic',
      }
    }

    case 'nvidia': {
      const apiKey = config.nvidiaApiKey as string
      if (!apiKey) throw new Error('NVIDIA NIM API key not configured. Run /login first.')
      const nvidiaBaseUrl = (config.nvidiaBaseUrl as string) || 'https://integrate.api.nvidia.com/v1'
      return {
        baseUrl: nvidiaBaseUrl,
        apiKey,
        model: model || (config.nvidiaModel as string) || 'nvidia/llama-3.1-nemotron-70b-instruct',
        protocol: 'openai',
      }
    }

    case 'opencode': {
      const apiKey = config.openCodeApiKey as string
      return {
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKey: apiKey || 'public',
        model: model || (config.openCodeModelName as string) || 'big-pickle',
        protocol: 'openai',
      }
    }

    case 'openai': {
      const apiKey = (config.openAiApiKey as string) || (config.openAiAccessToken as string)
      if (!apiKey) throw new Error('OpenAI API key not configured.')
      return {
        baseUrl: (process.env as Record<string, string>).OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey,
        model: model || 'gpt-5.4-codex',
        protocol: 'openai',
      }
    }

    case 'local': {
      const localBaseUrl = config.localBaseUrl as string
      if (!localBaseUrl) throw new Error('Local provider base URL not configured.')
      return {
        baseUrl: localBaseUrl,
        apiKey: 'local-model',
        model: model || (config.localModelName as string) || 'local-model',
        protocol: 'openai', // Most local providers use OpenAI-compatible API
      }
    }

    default: {
      // First-party Anthropic
      const apiKey = config.anthropicApiKey as string
      if (!apiKey) throw new Error('Anthropic API key not configured.')
      return {
        baseUrl: (process.env as Record<string, string>).ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
        apiKey,
        model: model || 'claude-sonnet-4-6',
        protocol: 'anthropic',
      }
    }
  }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'User-Agent': 'versperclaw-desktop/1.0',
  }
}

function openaiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'versperclaw-desktop/1.0',
  }
}

// ─── OpenAI protocol streaming ───────────────────────────────────────────────

async function* streamOpenAI(
  config: ProviderClientConfig,
  messages: ConversationMessage[],
  signal?: AbortSignal,
): AsyncGenerator<ConversationStreamEvent> {
  const body = {
    model: config.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: true,
  }

  let res: Response
  try {
    res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: openaiHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    const name = err instanceof TypeError ? err.name : ''
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tuiConversation] OpenAI fetch failed:', { name, message: msg, url: config.baseUrl, model: config.model })
    yield { type: 'error', message: `Network error: ${msg}${name ? ` (${name})` : ''}` }
    yield { type: 'done' }
    return
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    yield { type: 'error', message: `API error ${res.status}: ${errBody}` }
    yield { type: 'done' }
    return
  }

  if (!res.body) {
    yield { type: 'error', message: 'No response body' }
    yield { type: 'done' }
    return
  }

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffer = ''

  yield { type: 'content_block_start', index: 0, blockType: 'text' }

  while (true) {
    if (signal?.aborted) break
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (raw === '[DONE]') {
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'done' }
        return
      }

      try {
        const chunk = JSON.parse(raw)
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        if (delta.content) {
          yield { type: 'text_delta', text: delta.content }
        }
        if (delta.reasoning_content) {
          yield { type: 'thinking_delta', thinking: delta.reasoning_content }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_stop' }
  yield { type: 'done' }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a conversation message and stream the response.
 * Works for all provider types, bypassing the cc-haha sidecar.
 *
 * Usage:
 * ```ts
 * for await (const event of sendMessage([...messages])) {
 *   if (event.type === 'text_delta') { updateUI(event.text) }
 *   if (event.type === 'done') { break }
 * }
 * ```
 */
export async function* sendMessage(
  messages: ConversationMessage[],
  options?: {
    model?: string
    system?: string
    signal?: AbortSignal
  },
): AsyncGenerator<ConversationStreamEvent> {
  const config = await resolveProviderConfig(options?.model)

  if (config.protocol === 'anthropic') {
    // Re-implement Anthropic streaming inline with proper yield support
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: 4096,
      stream: true,
    }
    if (options?.system) body.system = options.system

    let res: Response
    try {
      res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        headers: anthropicHeaders(config.apiKey),
        body: JSON.stringify(body),
        signal: options?.signal,
      })
    } catch (err) {
      const name = err instanceof TypeError ? err.name : ''
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[tuiConversation] Anthropic fetch failed:', { name, message: msg, url: config.baseUrl, model: config.model })
      yield { type: 'error', message: `Network error: ${msg}${name ? ` (${name})` : ''}` }
      yield { type: 'done' }
      return
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      yield { type: 'error', message: `API error ${res.status}: ${errBody}` }
      yield { type: 'done' }
      return
    }

    if (!res.body) {
      yield { type: 'error', message: 'No response body' }
      yield { type: 'done' }
      return
    }

    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let buffer = ''
    let usage: { input_tokens?: number; output_tokens?: number } | undefined

    try {
      while (true) {
        if (options?.signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const raw = line.slice(6).trim()
            if (!raw) continue

            try {
              const data = JSON.parse(raw)

              if (data.type === 'content_block_start') {
                yield {
                  type: 'content_block_start',
                  index: data.index ?? 0,
                  blockType: data.content_block?.type ?? 'text',
                }
              } else if (data.type === 'content_block_delta') {
                const delta = data.delta
                if (delta?.type === 'text_delta' && delta.text) {
                  yield { type: 'text_delta', text: delta.text }
                } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                  yield { type: 'thinking_delta', thinking: delta.thinking }
                }
              } else if (data.type === 'content_block_stop') {
                yield { type: 'content_block_stop', index: data.index ?? 0 }
              } else if (data.type === 'message_start' && data.message?.usage) {
                usage = data.message.usage
              } else if (data.type === 'message_delta' && data.delta?.stop_reason) {
                if (data.usage) usage = data.usage
              } else if (data.type === 'message_stop') {
                yield { type: 'message_stop', usage }
                yield { type: 'done' }
                return
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    if (!options?.signal?.aborted) {
      yield { type: 'message_stop', usage }
      yield { type: 'done' }
    }
  } else {
    // OpenAI protocol
    yield* streamOpenAI(config, messages, options?.signal)
  }
}

/**
 * Non-streaming send - returns the complete result.
 */
export async function sendMessageSync(
  messages: ConversationMessage[],
  options?: {
    model?: string
    system?: string
    signal?: AbortSignal
  },
): Promise<ConversationResult> {
  const config = await resolveProviderConfig(options?.model)

  if (config.protocol === 'anthropic') {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: 4096,
    }
    if (options?.system) body.system = options.system

    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: anthropicHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`API error ${res.status}: ${errBody}`)
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>
      usage?: { input_tokens: number; output_tokens: number }
    }

    const text = data.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n') ?? ''

    return { content: text, usage: data.usage }
  }

  // OpenAI protocol
  const body = {
    model: config.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  }

  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: openaiHeaders(config.apiKey),
    body: JSON.stringify(body),
    signal: options?.signal,
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`API error ${res.status}: ${errBody}`)
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string | null } }>
    usage?: { prompt_tokens: number; completion_tokens: number }
  }

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens } : undefined,
  }
}
