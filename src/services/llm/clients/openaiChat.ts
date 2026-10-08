/**
 * OpenAI Chat 协议共享客户端 — OpenAI / OpenCode / DeepSeek / Qwen 等凡走 openai-chat 的 Provider 共用。
 * Provider 仅提供 endpoint/protocol/model mapping/auth identity 元数据，Client 只懂协议。
 *
 * Native 实现：wire 装配（请求体/消息/工具/SSE 解析）位于 protocols/openaiChatWire.ts，
 * 不经 @ant/model-provider / Anthropic 消息中间表示。reasoning 直接读
 * LLMRequestConfig（config.thinking / context.effortValue）。
 */
import type { LLMRoute } from '../types.js'
import type { LLMRequest } from '../runtime/types.js'
import type { StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js'
import type { AgentContentBlock } from '../../../types/agentMessage.js'
import { APIUserAbortError } from '@anthropic-ai/sdk/error'
import { randomUUID } from 'crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { httpRequest } from '../transport/http.js'
import { requestWithRetry } from '../transport/retryHttpRequest.js'
import { parseOpenAIChunksFromSSE } from '../transport/sse.js'
import { detectUpstreamFailures, UpstreamStreamError } from '../protocols/upstreamError.js'
import { completionToChunks } from '../protocols/openaiCompletionToChunks.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import type { AgentId } from '../../../types/ids.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { isAbortError } from '../../../utils/errors.js'
import { resolveOpenAIMaxTokens } from '../utils/requestBody.js'
import { formatOpenAIPromptCacheKey, updateOpenAIUsage } from '../utils/openaiShared.js'
import { resolveAuth } from '../auth/resolveAuth.js'
import { createRequestId, getOpencodeUserAgent, translateSessionId, FINGERPRINT_TOOLS } from '../../api/opencodeUserAgent.js'
import { getNvidiaModelMaxTokens } from '../../../utils/model/nvidiaModels.js'
import {
  adaptOpenAIChatSSE,
  agentMessagesToOpenAIChatMessages,
  buildOpenAIChatBody,
  chatCompletionsUrlFromBase,
  openAIChatToolChoiceFromLLM,
  openAIChatToolsFromSchemas,
  resolveOpenAIChatThinking,
  type OpenAIChatNormalizedUsage,
  type OpenAIChatStreamEvent,
  type OpenAIChatWireChunk,
} from '../protocols/openaiChatWire.js'
import {
  applyCacheStableSystemPrompt,
  providerSplitsSystemPromptForCache,
  stripSystemDynamicBoundary,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../protocols/cacheStablePrompt.js'
import {
  applyGeminiOpenRouterCacheAnchor,
  isGeminiOnOpenRouter,
} from '../protocols/openrouterGeminiCache.js'
import { freezeOpenRouterTools } from '../protocols/openrouterToolFreeze.js'
import { providerModelSupportsImages } from '../models/visionSupport.js'
import { sanitizeToolCallAdjacency } from '../protocols/sanitizeToolAdjacency.js'

type OpenAIChatStartMessage = Extract<OpenAIChatStreamEvent, { type: 'message_start' }>['message']

// Upstream-retry policy (mirrors the OpenRouter lane): capacity errors back
// off, anything else gets one recovery attempt; both stop once content has
// been published.
let capacityRetryDelaysMs = [2_000, 4_000, 8_000, 16_000]
let recoveryRetryDelayMs = 500
const MAX_CAPACITY_WAIT_MS = 60_000
const MAX_TOTAL_RETRY_WAIT_MS = 30_000

/** Test-only: shrink the backoff so retry paths run fast. */
export function _setOpenAIStreamRetryDelaysForTest(
  capacity?: number[],
  recovery?: number,
): void {
  if (capacity) capacityRetryDelaysMs = capacity
  if (recovery !== undefined) recoveryRetryDelayMs = recovery
}

export function _resetOpenAIStreamRetryDelaysForTest(): void {
  capacityRetryDelaysMs = [2_000, 4_000, 8_000, 16_000]
  recoveryRetryDelayMs = 500
}

export async function* queryOpenAIChat(
  route: LLMRoute,
  request: LLMRequest,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal, config, context } = request
  let partialMessage: OpenAIChatStartMessage | null = null
  let ttftMs = 0
  const start = Date.now()
  let usage: OpenAIChatNormalizedUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let stopReason: string | null = null
  let maxTokens = 0
  try {
    let model = route.model
    const endpoint = route.endpoint ?? ''
    if (!endpoint) throw new Error(`openai-chat route missing endpoint for provider ${route.provider}`)
    const cred = resolveAuth(route.provider)
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)
    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: context.getToolPermissionContext,
          tools,
          agents: context.agents,
          allowedAgentTypes: context.allowedAgentTypes,
          model,
        }),
      ),
    )
    const systemText = systemPrompt?.join('\n')
    // Three-state vision: only a catalog that positively knows the model takes
    // images unlocks pixels; false and unknown fall back to text.
    const supportsImages = providerModelSupportsImages(route.provider, model)
    // OpenRouter returns typed reasoning state (reasoning_details) that must be
    // echoed back for multi-turn reasoning continuity; other endpoints reject
    // the unknown field, so gate it on the provider.
    const supportsReasoningDetails = route.provider === 'openrouter'
    let openaiMessages = agentMessagesToOpenAIChatMessages(
      messagesForAPI,
      systemText,
      { supportsImages, supportsReasoningDetails },
    )
    // Implicit prefix-cache providers (DeepSeek, OpenRouter): split the
    // volatile system tail out, freeze it for the session, and pin it at a
    // fixed leading position so a mid-session git status or MCP connect cannot
    // rewrite the cached head. Other providers must never see the literal
    // boundary marker.
    if (systemText) {
      if (providerSplitsSystemPromptForCache(route.provider, model)) {
        openaiMessages = applyCacheStableSystemPrompt(openaiMessages, systemText, {
          lane: route.provider,
          model,
          sessionId: getSessionId(),
        })
      } else if (systemText.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) {
        openaiMessages = agentMessagesToOpenAIChatMessages(
          messagesForAPI,
          stripSystemDynamicBoundary(systemText),
          { supportsImages, supportsReasoningDetails },
        )
      }
    }
    // Gemini-on-OpenRouter: one explicit cache breakpoint advanced in quanta.
    // Explicit caching is synchronous and deterministic, unlike the implicit
    // commit lottery; see the module doc for the anchor strategy.
    if (route.provider === 'openrouter' && isGeminiOnOpenRouter(model)) {
      applyGeminiOpenRouterCacheAnchor(openaiMessages)
    }
    // DeepSeek rejects a request whose tool results do not answer the adjacent
    // assistant tool_calls (orphans appear after history trimming/filtering).
    if (model.toLowerCase().includes('deepseek')) {
      openaiMessages = sanitizeToolCallAdjacency(openaiMessages)
    }
    const openaiTools = openAIChatToolsFromSchemas(
      toolSchemas
        .filter(t => {
          const anyT = t as unknown as Record<string, unknown>
          return anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        })
        .map(t => {
          const rec = t as unknown as Record<string, unknown>
          return {
            name: (rec.name as string) ?? '',
            description: rec.description as string | undefined,
            input_schema: rec.input_schema as Record<string, unknown> | undefined,
          }
        }),
    )
    let isFree = model.includes('free') || model.includes('contributor')
    try {
      const { getCachedOpencodeModels } = await import('../../../utils/model/opencodeModels.js')
      const list = getCachedOpencodeModels()
      if (list.length > 0) {
        const meta = list.find(m => m.id === model || model.includes(m.id) || m.id.includes(model))
        if (meta) isFree = !!meta.isFree
      }
    } catch {}
    const { upperLimit } = getModelMaxOutputTokens(model)
    // opencode 模型按目录 limit.output 裁剪 max_tokens：未知模型默认 64000 会超过
    // mimo-v2.5-free(32000)/ling-3.0-flash-fin-free(32768)/big-pickle(32000) 的上限，
    // Zen 当前容忍超发，但严格校验即 400。用目录值 clamp，缺失时回退默认。
    let effectiveUpperLimit = upperLimit
    if (route.provider === 'opencode') {
      try {
        const { getOpencodeModelMaxTokens } = await import('../../../utils/model/opencodeModels.js')
        const catalogCap = getOpencodeModelMaxTokens(model)
        if (typeof catalogCap === 'number' && catalogCap >= 4_096) {
          effectiveUpperLimit = Math.min(upperLimit, catalogCap)
        }
      } catch {}
    }
    if (route.provider === 'nvidia') {
      const catalogCap = getNvidiaModelMaxTokens(model)
      if (typeof catalogCap === 'number' && catalogCap >= 4_096) {
        effectiveUpperLimit = Math.min(effectiveUpperLimit, catalogCap)
      }
    }
    maxTokens = resolveOpenAIMaxTokens(effectiveUpperLimit, config.maxOutputTokens)
    // NVIDIA NIM implements the OpenAI Chat API but does not accept
    // OpenAI's provider-specific prompt_cache_key extension.
    const promptCacheKey =
      route.provider === 'nvidia' ? undefined : formatOpenAIPromptCacheKey(getSessionId())
    // reasoning 由 LLMRequestConfig 直构：config.thinking / context.effortValue /
    // 模型与 env 检测都归口到 native thinking 配置，见 resolveOpenAIChatThinking。
    const { enableThinking, reasoning_effort: reasoningEffort } = resolveOpenAIChatThinking(model, config, context)
    // NVIDIA NIM rejects the generic enable_thinking/thinking fields.
    const isNvidiaGptOss =
      route.provider === 'nvidia' && model.toLowerCase().includes('gpt-oss')
    const providerEnableThinking = route.provider !== 'nvidia' && enableThinking
    const providerReasoningEffort =
      route.provider === 'nvidia'
        ? isNvidiaGptOss
          ? reasoningEffort
          : undefined
        : reasoningEffort
    // Free tier opencode: ensure fingerprint tools + stream=true (#4132)
    let effectiveTools = openaiTools
    if (route.provider === 'opencode' && isFree) {
      const existingNames = new Set(openaiTools.map((t: any) => t.name ?? t.function?.name ?? ''))
      const missing = FINGERPRINT_TOOLS.filter((n) => !existingNames.has(n))
      if (missing.length > 0) {
        const injected = missing.map((name) => ({
          type: 'function' as const,
          function: { name, description: `${name} tool (fingerprint for free tier)`, parameters: {} },
        }))
        effectiveTools = [...openaiTools, ...injected]
      }
    }
    // OpenRouter prefix cache: hold tool order + descriptions stable for this
    // conversation so a reconnecting MCP server or a reordered list cannot
    // cold-start the cached prefix. Availability/schema stay authoritative.
    if (route.provider === 'openrouter') {
      const lineage = context.agentId ?? context.querySource ?? 'main'
      effectiveTools = freezeOpenRouterTools(
        `or-tools:${model.toLowerCase()}:${getSessionId() ?? 'no-session'}:${lineage}`,
        effectiveTools,
      )
    }
    logForDebugging(`[OpenAIChat] provider=${route.provider} model=${model} endpoint=${endpoint} tools=${effectiveTools.length} thinking=${providerEnableThinking ? 'on' : 'off'}`)
    const body = buildOpenAIChatBody({
      model,
      messages: openaiMessages,
      tools: effectiveTools,
      toolChoice: openAIChatToolChoiceFromLLM(config.toolChoice),
      enableThinking: providerEnableThinking,
      reasoningEffort: providerReasoningEffort,
      maxTokens,
      temperatureOverride: config.temperature,
      promptCacheKey,
    })
    // Free tier opencode: force stream=true, backend SSE only (#4132)
    if (route.provider === 'opencode' && isFree) {
      ;(body as any).stream = true
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': route.provider === 'opencode' ? getOpencodeUserAgent() : 'codev',
    }
    // Provider-specific headers 按 opencode 侧 custom 定义
    if (route.provider === 'opencode') {
      headers['x-opencode-client'] = 'desktop'
      headers['x-opencode-project'] = 'global'
      headers['x-opencode-session'] = translateSessionId(getSessionId() || '', 'codev')
      headers['x-opencode-request'] = createRequestId()
    } else if (route.provider === 'nvidia') {
      headers['HTTP-Referer'] = 'https://opencode.ai/'
      headers['X-Title'] = 'opencode'
      headers['X-BILLING-INVOKE-ORIGIN'] = 'OpenCode'
    } else if (route.provider === 'openrouter') {
      // OpenRouter attributes requests by referer/title; both optional.
      headers['HTTP-Referer'] = 'https://opencode.ai/'
      headers['X-Title'] = 'codev'
    }
    if (cred.type === 'bearer') headers.Authorization = `Bearer ${cred.token}`
    else headers.Authorization = 'Bearer public'
    const fetchOverride = context.fetchOverride as unknown as typeof fetch | undefined
    const url = endpoint.includes('/chat/completions') ? endpoint : chatCompletionsUrlFromBase(endpoint)
    const sendRequest = (requestBody: object) =>
      requestWithRetry(
        () =>
          httpRequest(
            { url, method: 'POST', headers, body: JSON.stringify(requestBody), signal },
            fetchOverride,
          ),
        signal,
      )
    const buildRecoveryBody = () => {
      const { stream_options: _streamOptions, ...rest } = body as unknown as Record<string, unknown>
      return { ...rest, stream: false }
    }
    let response: Response
    // Retry only while nothing has reached the consumer: an upstream error
    // frame as the first stream event (OpenRouter reports rate limiting and
    // no-capacity that way) is retried; once any event has been yielded,
    // replaying would duplicate content, so the error surfaces instead.
    let published = false
    let capacityWaits = 0
    let waitedMs = 0
    let recoveryUsed = false
    // Non-capacity failures get one non-streaming recovery: a complete JSON
    // completion cannot fail midway the way the stream did.
    let recovery = false
    let newMessages: AssistantMessage[] = []
    for (;;) {
      const attemptBody = recovery ? buildRecoveryBody() : body
      response = await sendRequest(attemptBody)
      // 免费模型瞬态 500 按 opencode 策略重试并回退至 big-pickle，确保 hi 可用
      if (!response.ok && isFree && response.status === 500 && model !== 'big-pickle') {
        logForDebugging(`[OpenAIChat] free model ${model} 500, fallback to big-pickle`)
        ;(body as { model?: string }).model = 'big-pickle'
        model = 'big-pickle'
        response = await sendRequest(attemptBody)
        if (response.ok) {
          logForDebugging(`[OpenAIChat] free-tier fallback succeeded with ${model}`)
        }
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Upstream ${route.provider} failed (${response.status})${text ? `: ${text.slice(0, 800)}` : ''}`)
      }
      if (!response.body) throw new Error('Upstream response missing body')
      partialMessage = null
      stopReason = null
      usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      newMessages = []
      const chunkSource: AsyncIterable<Record<string, unknown>> = recovery
        ? (async function* () {
            for (const chunk of completionToChunks(await response.json())) yield chunk
          })()
        : (parseOpenAIChunksFromSSE(response.body) as AsyncIterable<Record<string, unknown>>)
      const adaptedStream = adaptOpenAIChatSSE(detectUpstreamFailures(chunkSource) as AsyncIterable<OpenAIChatWireChunk>, model, { includeCacheWriteTokens: false })
      const contentBlocks: Record<number, Record<string, unknown>> = {}
      try {
      for await (const event of adaptedStream) {
        switch (event.type) {
          case 'message_start': {
            partialMessage = event.message
            ttftMs = Date.now() - start
            if (event.message.usage) usage = { ...usage, ...(event.message.usage as unknown as typeof usage) }
            break
          }
          case 'content_block_start': {
            const idx = event.index
            const cb = event.content_block as unknown as Record<string, unknown>
            if (cb.type === 'tool_use') contentBlocks[idx] = { ...cb, input: '' }
            else if (cb.type === 'text') contentBlocks[idx] = { ...cb, text: '' }
            else if (cb.type === 'thinking') contentBlocks[idx] = { ...cb, thinking: '' }
            else contentBlocks[idx] = { ...cb }
            break
          }
          case 'content_block_delta': {
            const idx = event.index
            const block = contentBlocks[idx] as Record<string, unknown> | undefined
            if (!block) break
            const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; reasoning_details?: unknown }
            if (delta.type === 'text_delta') block.text = ((block.text as string | undefined) || '') + delta.text
            else if (delta.type === 'input_json_delta') block.input = ((block.input as string | undefined) || '') + delta.partial_json
            else if (delta.type === 'thinking_delta') block.thinking = ((block.thinking as string | undefined) || '') + delta.thinking
            else if (delta.type === 'reasoning_details_delta' && Array.isArray(delta.reasoning_details)) {
              // Opaque OpenRouter reasoning state rides the thinking block so
              // it survives transcript save/resume and is echoed next turn.
              block.providerOptions = {
                ...(block.providerOptions as Record<string, unknown> | undefined),
                openrouterReasoningDetails: delta.reasoning_details,
              }
            }
            break
          }
          case 'content_block_stop': {
            const contentBlock = contentBlocks[event.index]
            if (!contentBlock || !partialMessage) break
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                content: normalizeContentFromAPI([contentBlock] as unknown as AgentContentBlock[], tools, context.agentId as AgentId | undefined),
              },
              requestId: undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
            } as unknown as AssistantMessage
            newMessages.push(m)
            published = true
            yield m
            break
          }
          case 'message_delta': {
            const deltaUsage = event.usage
            if (deltaUsage) usage = updateOpenAIUsage(usage, deltaUsage as unknown as Parameters<typeof updateOpenAIUsage>[1])
            if (event.delta?.stop_reason != null) stopReason = event.delta.stop_reason
            const lastMsg = newMessages.at(-1) as (AssistantMessage & { message: { usage?: typeof usage; stop_reason?: string | null } }) | undefined
            if (lastMsg) {
              lastMsg.message.usage = usage
              lastMsg.message.stop_reason = stopReason
            }
            if (usage.input_tokens + usage.output_tokens > 0) {
              const costUSD = calculateUSDCost(model, usage as unknown as Parameters<typeof calculateUSDCost>[1])
              addToTotalSessionCost(costUSD, usage as unknown as Parameters<typeof addToTotalSessionCost>[1], context.model)
            }
            break
          }
          case 'message_stop': break
        }
        published = true
        yield { type: 'stream_event', event, ...(event.type === 'message_start' ? { ttftMs } : undefined) } as unknown as StreamEvent
      }
      break
      } catch (error) {
        if (isAbortError(error)) throw error
        if (!(error instanceof UpstreamStreamError)) throw error
        const failure = error.failure
        let delayMs: number
        if (failure.capacity) {
          const scheduled = capacityRetryDelaysMs[capacityWaits]
          if (
            published ||
            scheduled === undefined ||
            (failure.retryAfterMs ?? 0) > MAX_CAPACITY_WAIT_MS ||
            waitedMs + scheduled > MAX_TOTAL_RETRY_WAIT_MS
          ) {
            error.message += ` Recovery was not attempted${published ? ': output was already published' : ''}.`
            throw error
          }
          delayMs = Math.max(failure.retryAfterMs ?? 0, Math.round(scheduled * (0.8 + Math.random() * 0.4)))
          capacityWaits++
        } else {
          if (published || recoveryUsed) {
            error.message += ` Recovery was not attempted${published ? ': output was already published' : ': the recovery retry already ran'}.`
            throw error
          }
          recoveryUsed = true
          recovery = true
          delayMs = recoveryRetryDelayMs
        }
        logForDebugging(`[OpenAIChat] retrying after upstream error (${failure.capacity ? 'capacity' : 'recovery'}): ${failure.message}`)
        waitedMs += delayMs
        await sleep(delayMs, undefined, { signal })
      }
    }
    const lastMsg = newMessages.at(-1) as
      | (AssistantMessage & {
          message: {
            content: unknown[]
            usage?: OpenAIChatNormalizedUsage
            stop_reason?: string | null
          }
        })
      | undefined
    const lastHasToolUse = (lastMsg?.message.content ?? []).some(block => (block as { type?: string }).type === 'tool_use') ?? false
    if (stopReason === null && !lastHasToolUse) {
      if (lastMsg) {
        lastMsg.message.usage = usage
        lastMsg.message.stop_reason = 'max_tokens'
      }
      yield createAssistantAPIErrorMessage({
        content: `Upstream ${route.provider} response exceeded ${maxTokens} tokens`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens' as any,
      })
    }
  } catch (error) {
    if (isAbortError(error)) throw error instanceof APIUserAbortError ? error : new APIUserAbortError()
    const msg = error instanceof Error ? error.message : String(error)
    yield createAssistantAPIErrorMessage({ content: `API Error: ${msg}`, apiError: 'api_error', error })
  }
}