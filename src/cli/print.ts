/**
 * Print utility functions — headless / SDK bridge
 *
 * runHeadless has two paths:
 *   - SDK mode (--sdk-url): WebSocket ↔ QueryEngine bridge, messages are
 *     forwarded verbatim to the host.
 *   - Plain headless (-p without --sdk-url): QueryEngine consumes
 *     inputPrompt and writes output to stdout according to --output-format
 *     (text | json | stream-json), with a result-driven exit code.
 *
 * This file exports:
 *   - runHeadless()     — headless entry point (both modes)
 *   - externalMetadataToAppState() — stub for headless metadata
 */

import { getCwd } from '../utils/cwd.js'
import { createAbortController } from '../utils/abortController.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js'
import {
  registerProcessOutputErrorHandlers,
  writeToStdout,
} from '../utils/process.js'
import { installStreamJsonStdoutGuard } from '../utils/streamJsonStdoutGuard.js'

export function externalMetadataToAppState(metadata: any): any {
  console.error('externalMetadataToAppState not implemented');
  return {};
}

// ── SDK protocol helpers ──────────────────────────────────────────────

function extractUserText(msg: any): string {
  const content = msg?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join(' ')
}

function sendWs(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload) + '\n')
  }
}

// ── Non-SDK headless — -p without --sdk-url ───────────────────────────

type NonSDKHeadlessOptions = {
  verbose?: boolean
  outputFormat?: string
  jsonSchema?: Record<string, unknown>
  allowedTools?: string[]
  thinkingConfig?: { type: string; [key: string]: unknown }
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  systemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  replayUserMessages?: boolean
  includePartialMessages?: boolean
}

/**
 * Stringify an SDK message for NDJSON output. BigInt is not valid JSON — a
 * replacer keeps a stray bigint from crashing an entire stream-json line.
 */
function ndjsonSafeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  )
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  )
}

/**
 * 非 SDK headless 退出前收尾：先把 transcript 落盘（QueryEngine 在 yield result
 * 前已 flush 缓冲写入，这里只兜底 fire-and-forget 的尾巴），再排空 stdio，
 * 最后显式退出。
 *
 * 显式退出的原因：-p 是单轮脚本模式，但启动链（fetch 连接池、文件监听、
 * 各类后台单例）会留下事件循环句柄，进程答完也不退出。desktop 侧本来就是
 * 收到 result 就杀 CLI（见 QueryEngine 落盘注释），-p 自己退出语义一致。
 * SDK WebSocket 模式不走这里（等对端挂断）。
 */
async function settleAndExitHeadless(): Promise<never> {
  try {
    const { flushSessionStorage } = await import('../utils/sessionStorage.js')
    await Promise.race([
      flushSessionStorage().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 3000).unref()),
    ])
  } catch {
    // 落盘失败不阻塞退出
  }
  await Promise.all([drainStream(process.stdout), drainStream(process.stderr)])
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(process.exitCode ?? 0)
}

function drainStream(stream: NodeJS.WriteStream, timeoutMs = 2000): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs).unref()
    try {
      if ((stream as { destroyed?: boolean }).destroyed) {
        finish()
        return
      }
      // 空写回调在之前排队的数据刷出后触发；EPIPE 等异常直接放行
      stream.write('', finish)
    } catch {
      finish()
    }
  })
}

/**
 * The headless store may carry no file cache yet (fresh process). cloneFileStateCache
 * requires a real cache (it reads `cache.max`), so fall back to an empty one.
 */
function getReadFileCache(state: any): FileStateCache {
  if (state?.files != null) {
    return cloneFileStateCache(state.files)
  }
  return createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
}

/**
 * text 模式下从一条 result 消息提取 stdout 文本。
 * 成功结果取 `result`；无文本（如末块非 text）返回 null，调用方保持静默以免污染管道。
 */
export function getHeadlessResultText(sdkMsg: {
  type?: string
  result?: string
}): string | null {
  if (sdkMsg?.type !== 'result') return null
  const text = sdkMsg.result ?? ''
  return text.length > 0 ? text : null
}

/**
 * text 模式下为“零输出的 error 结果”生成 stderr 摘要。
 * error_during_execution 等结果没有 `result` 字段（只有 errors[]），旧逻辑直接
 * 静默，-p 用户看到的就是“没反应”。这里返回可打印的摘要，调用方写 stderr，
 * stdout 依然保持纯净（管道友好），进程退出码仍为 1。
 * 非 error 结果返回 null。
 */
export function getHeadlessErrorSummary(sdkMsg: {
  type?: string
  subtype?: string
  is_error?: boolean
  errors?: string[]
  stop_reason?: string | null
}): string | null {
  if (sdkMsg?.type !== 'result') return null
  const isError = sdkMsg.is_error === true || (sdkMsg.subtype !== undefined && sdkMsg.subtype !== 'success')
  if (!isError) return null
  if (getHeadlessResultText(sdkMsg as { type?: string; result?: string }) !== null) return null
  const errors = Array.isArray(sdkMsg.errors) ? sdkMsg.errors : []
  const detail = errors.length > 0 ? errors.join('\n') : `subtype=${sdkMsg.subtype ?? 'unknown'} stop_reason=${sdkMsg.stop_reason ?? 'null'}`
  return `request failed (${sdkMsg.subtype ?? 'error'}):\n${detail}`
}

/**
 * Plain headless query: consume inputPrompt (string = single turn;
 * AsyncIterable from --input-format=stream-json = one turn per line/chunk)
 * through QueryEngine, and emit output per --output-format:
 *   - text        — final result text(s) to stdout, one line each
 *   - json        — the result SDK message(s) as one JSON line each
 *   - stream-json — every SDK message as NDJSON (stdout guard installed so
 *                   stray non-JSON writes are diverted, not mixed in)
 *
 * The process exits 0 on success and 1 when any turn ends in an error result
 * (error_during_execution / max turns / budget / structured-output retries /
 * API error). Non-interactive print mode is implicitly trusted (main.tsx
 * skips the trust dialog for --print), so tools default to allow; an
 * --allowed-tools list narrows that to a denylist, matching scripting
 * conventions.
 */
async function runNonSDKHeadless(params: {
  inputPrompt: unknown
  getState: () => any
  setState: (fn: (state: any) => any) => void
  commandsHeadless: readonly any[]
  tools: readonly any[]
  activeAgents: readonly any[]
  options: NonSDKHeadlessOptions
}): Promise<void> {
  const {
    inputPrompt,
    getState,
    setState,
    commandsHeadless,
    tools,
    activeAgents,
    options,
  } = params

  const outputFormat = options.outputFormat ?? 'text'
  const isStreamJson = outputFormat === 'stream-json'
  const isJson = outputFormat === 'json'

  if (isStreamJson) {
    // stream-json consumers parse stdout line-by-line as NDJSON; any stray
    // write from a dependency would break their parser mid-stream.
    installStreamJsonStdoutGuard()
  }
  // `codev -p | head -1` must not crash the process on EPIPE.
  registerProcessOutputErrorHandlers()

  const abortController = createAbortController()
  const { QueryEngine } = await import('../QueryEngine.js')
  const state = getState()
  const mcpClients = state?.mcp?.clients ?? []
  const readFileCache = getReadFileCache(state)

  try {
    if (typeof inputPrompt === 'string') {
      await runHeadlessTurns([inputPrompt], {
        outputFormat,
        isStreamJson,
        isJson,
        options,
        getState,
        setState,
        commandsHeadless,
        tools,
        activeAgents,
        abortController,
        mcpClients,
        readFileCache,
      })
    } else if (isAsyncIterable(inputPrompt)) {
      // --input-format=stream-json: the stdin stream yields chunks; each line
      // is one user message/turn.
      const lines: string[] = []
      for await (const chunk of inputPrompt) {
        const text =
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf-8')
        lines.push(...text.split('\n'))
      }
      await runHeadlessTurns(lines, {
        outputFormat,
        isStreamJson,
        isJson,
        options,
        getState,
        setState,
        commandsHeadless,
        tools,
        activeAgents,
        abortController,
        mcpClients,
        readFileCache,
      })
    }
  } catch (error) {
    console.error(
      '[runHeadless] headless query failed:',
      error instanceof Error ? error.stack : String(error),
    )
    process.exitCode = 1
  }
  // 非 SDK headless 跑完即退出（落盘+排空后显式 exit，见 settleAndExitHeadless）
  await settleAndExitHeadless()
}

async function runHeadlessTurns(
  prompts: string[],
  ctx: {
    outputFormat: string
    isStreamJson: boolean
    isJson: boolean
    options: NonSDKHeadlessOptions
    getState: () => any
    setState: (fn: (state: any) => any) => void
    commandsHeadless: readonly any[]
    tools: readonly any[]
    activeAgents: readonly any[]
    abortController: AbortController
    mcpClients: any[]
    readFileCache: ReturnType<typeof cloneFileStateCache>
  },
): Promise<void> {
  const { QueryEngine } = await import('../QueryEngine.js')
  const {
    outputFormat,
    isStreamJson,
    isJson,
    options,
    getState,
    setState,
    commandsHeadless,
    tools,
    activeAgents,
    abortController,
    mcpClients,
    readFileCache,
  } = ctx

  let hadError = false

  for (const rawPrompt of prompts) {
    const prompt = rawPrompt.trim()
    if (!prompt) continue

    // Fresh engine per turn (same lifecycle as the SDK path) — long stdin
    // streams don't accumulate session state between turns.
    const engine = new QueryEngine({
      cwd: getCwd(),
      tools: tools as any,
      commands: commandsHeadless as any,
      mcpClients,
      agents: activeAgents as any,
      canUseTool: async tool => {
        if (
          options.allowedTools &&
          !options.allowedTools.includes(tool.name)
        ) {
          return {
            behavior: 'deny' as const,
            message: `Tool ${tool.name} is not allowed by -p (allowedTools).`,
            decisionReason: {
              type: 'other' as const,
              reason: 'blocked by headless allowedTools filter',
            },
          }
        }
        return { behavior: 'allow' as const }
      },
      getAppState: getState,
      setAppState: setState,
      initialMessages: [],
      readFileCache,
      verbose: !!options.verbose,
      thinkingConfig: options.thinkingConfig as any,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      taskBudget: options.taskBudget,
      jsonSchema: options.jsonSchema,
      replayUserMessages: !!options.replayUserMessages,
      // stream-json consumers want the full event stream (assistant deltas,
      // tool uses, usage) — not just the terminal result message.
      includePartialMessages: isStreamJson || !!options.includePartialMessages,
      userSpecifiedModel: options.userSpecifiedModel || undefined,
      fallbackModel: options.fallbackModel || undefined,
      customSystemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      setSDKStatus: (_status: string | null) => {
        /* no-op for plain headless */
      },
      abortController,
    })

    for await (const sdkMsg of engine.submitMessage(prompt)) {
      if (sdkMsg.type === 'result') {
        const isErrorResult = sdkMsg.is_error === true || sdkMsg.subtype !== 'success'
        if (isErrorResult) {
          hadError = true
        }

        if (isStreamJson || isJson) {
          writeToStdout(`${ndjsonSafeStringify(sdkMsg)}\n`)
        } else {
          // text: emit the final assistant text (one line per result).
          const text = getHeadlessResultText(sdkMsg as { type?: string; result?: string })
          if (text !== null) {
            writeToStdout(`${text}\n`)
          } else {
            // Zero-output error results (e.g. error_during_execution has
            // errors[] but no result) must not fail silently in -p: surface
            // a summary on stderr, stdout stays clean for pipes.
            const summary = getHeadlessErrorSummary(
              sdkMsg as {
                type?: string
                subtype?: string
                is_error?: boolean
                errors?: string[]
                stop_reason?: string | null
              },
            )
            if (summary !== null) {
              process.stderr.write(`[codev -p] ${summary}\n`)
            }
          }
        }
      } else if (isStreamJson) {
        // Full NDJSON stream: user / system / (when includePartialMessages)
        // stream_event messages, plus every result above.
        writeToStdout(`${ndjsonSafeStringify(sdkMsg)}\n`)
      }
    }
  }

  if (hadError) {
    process.exitCode = 1
  }
}

// ── runHeadless — headless entry point ─────────────────────────────────

export async function runHeadless(
  inputPrompt: unknown,
  getState: () => any,
  setState: (fn: (state: any) => any) => void,
  commandsHeadless: readonly any[],
  tools: readonly any[],
  _sdkMcpConfigs: unknown,
  activeAgents: readonly any[],
  options: {
    verbose?: boolean
    outputFormat?: string
    jsonSchema?: Record<string, unknown>
    allowedTools?: string[]
    thinkingConfig?: { type: string; [key: string]: unknown }
    maxTurns?: number
    maxBudgetUsd?: number
    taskBudget?: { total: number }
    systemPrompt?: string
    appendSystemPrompt?: string
    userSpecifiedModel?: string
    fallbackModel?: string
    sdkUrl?: string
    replayUserMessages?: boolean
    includePartialMessages?: boolean
    enableAuthStatus?: boolean
    agent?: unknown
  },
): Promise<void> {
  const sdkUrl = options.sdkUrl
  if (!sdkUrl) {
    await runNonSDKHeadless({
      inputPrompt,
      getState,
      setState,
      commandsHeadless,
      tools,
      activeAgents,
      options,
    })
    return
  }

  console.error(`[runHeadless] Connecting SDK WebSocket …`)

  const ws = new WebSocket(sdkUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      console.error('[runHeadless] SDK WebSocket connected')
      resolve()
    })
    ws.addEventListener('error', (err) => {
      console.error('[runHeadless] SDK WebSocket error:', err)
      reject(err)
    })
  })

  const abortController = createAbortController()

  // QueryEngine is lazy-imported so the first invocation bears the cost.
  const { QueryEngine } = await import('../QueryEngine.js')

  let engine: InstanceType<typeof QueryEngine> | null = null
  let processing = false
  const pendingMessages: any[] = []

  async function processNextMessage(msg: any): Promise<void> {
    const text = extractUserText(msg)
    if (!text.trim()) return

    const state = getState()

    if (!engine) {
      const mcpClients = state?.mcp?.clients ?? []
      engine = new QueryEngine({
        cwd: getCwd(),
        tools: tools as any,
        commands: commandsHeadless as any,
        mcpClients,
        agents: activeAgents as any,
        /** In SDK mode tool permission decisions are owned by the host
         *  (desktop server / remote client).  The CLI always allows;
         *  the host gates execution on its side. */
        canUseTool: async () => ({ behavior: 'allow' as const }),
        getAppState: getState,
        setAppState: setState,
        initialMessages: [],
        readFileCache: state?.files ? cloneFileStateCache(state.files) : cloneFileStateCache(undefined),
        verbose: !!options.verbose,
        thinkingConfig: options.thinkingConfig as any,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        taskBudget: options.taskBudget,
        jsonSchema: options.jsonSchema,
        replayUserMessages: !!options.replayUserMessages,
        includePartialMessages: !!options.includePartialMessages,
        userSpecifiedModel: options.userSpecifiedModel || undefined,
        fallbackModel: options.fallbackModel || undefined,
        setSDKStatus: (_status) => { /* no-op for now */ },
        abortController,
      })
    }

    try {
      for await (const sdkMsg of engine.submitMessage(text)) {
        sendWs(ws, sdkMsg as Record<string, unknown>)
      }
    } catch (err) {
      console.error('[runHeadless] submitMessage error:', err)
      sendWs(ws, {
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: err instanceof Error ? err.message : String(err),
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    }

    // Create a fresh engine for the next user turn.
    engine = null
  }

  async function processQueue(): Promise<void> {
    if (processing || pendingMessages.length === 0) return
    processing = true
    try {
      while (pendingMessages.length > 0) {
        const msg = pendingMessages.shift()!
        await processNextMessage(msg)
      }
    } finally {
      processing = false
    }
  }

  ws.addEventListener('message', (event) => {
    const payload = typeof event.data === 'string' ? event.data : String(event.data)
    const lines = payload.split('\n').map((l) => l.trim()).filter(Boolean)

    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'user') {
          pendingMessages.push(msg)
          void processQueue()
        } else if (msg.type === 'control_request') {
          handleControlRequest(msg, ws, setState, abortController)
        }
      } catch (err) {
        console.error('[runHeadless] Invalid JSON line:', err)
      }
    }
  })

  // Wait for the WebSocket to close (SDK session ended).
  await new Promise<void>((resolve) => {
    ws.addEventListener('close', () => {
      console.error('[runHeadless] SDK WebSocket closed')
      resolve()
    })
  })
}

// ── Control request handling ──────────────────────────────────────────

function handleControlRequest(
  msg: any,
  ws: WebSocket,
  setState: (fn: (state: any) => any) => void,
  abortController: AbortController,
): void {
  const { request_id, request } = msg
  if (!request_id) return

  switch (request?.subtype) {
    case 'interrupt': {
      abortController.abort()
      sendWs(ws, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Interrupted',
        usage: { input_tokens: 0, output_tokens: 0 },
        session_id: msg.session_id ?? '',
      })
      break
    }

    case 'set_permission_mode': {
      setState((prev: any) => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          mode: request.mode ?? prev.toolPermissionContext?.mode ?? 'default',
        },
      }))
      sendWs(ws, {
        type: 'control_response',
        response: { subtype: 'success', request_id, response: {} },
        session_id: msg.session_id ?? '',
      })
      break
    }

    case 'set_max_thinking_tokens': {
      sendWs(ws, {
        type: 'control_response',
        response: { subtype: 'success', request_id, response: {} },
        session_id: msg.session_id ?? '',
      })
      break
    }

    default: {
      sendWs(ws, {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id,
          error: `Unknown control request: ${request?.subtype ?? '<unknown>'}`,
        },
        session_id: msg.session_id ?? '',
      })
      break
    }
  }
}
