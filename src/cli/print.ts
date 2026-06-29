/**
 * Print utility functions — headless / SDK bridge
 *
 * The desktop server spawns the CLI subprocess with --print --sdk-url and
 * expects it to connect back via a WebSocket.  This file exports:
 *   - runHeadless()     — SDK WebSocket ↔ QueryEngine bridge
 *   - externalMetadataToAppState() — stub for headless metadata
 */

import { getCwd } from '../utils/cwd.js'
import { createAbortController } from '../utils/abortController.js'
import { cloneFileStateCache } from '../utils/fileStateCache.js'

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

// ── runHeadless — SDK mode entry point ────────────────────────────────

export async function runHeadless(
  _inputPrompt: unknown,
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
    console.error('[runHeadless] Non-SDK headless mode is not implemented')
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
