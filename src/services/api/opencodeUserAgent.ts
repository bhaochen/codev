import { createHash, randomBytes } from 'crypto'

// OpenCode v2.0.26+ required for free tier (since 2026-10-14)
const OPENCODE_VERSION = '2.0.26'
const OPENCODE_CHANNEL = 'latest'
const OPENCODE_CLIENT = 'cli'

// Provider-utils versions per protocol (from OpenCode 2.0.26 release binary)
const PROVIDER_UTILS = {
  chat: '4.0.23',
  responses: '4.0.40',
  anthropic: '4.0.46',
} as const

// Zen free tier endpoints (since 2026-10-14) - inference API, NOT zen/v1
const DEFAULT_BASE = 'https://opencode.ai/inference/v1'
const LEGACY_BASE = 'https://opencode.ai/zen/v1'

// OpenCode v2 free tier requires EXACTLY these two tools with VERBATIM definitions
// Upstream compares description and parameters exactly; do not reword or reformat
const CORE_TOOLS = ['read', 'shell'] as const

const CORE_PARAMETER: Record<string, string> = {
  read: 'path',
  shell: 'command',
}

// Verbatim from OpenCode v2.0.26 CLI - upstream compares description and parameters exactly
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they completes.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
        timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
        background: { type: 'boolean', description: 'Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use "&" at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
}

// Session ID validation regex with counter (low 12 bits inverted < 16)
// Upstream decodes prefix as ~(timeMs * 0x1000 + counter) and rejects non-small counter
const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const OPENCODE_SESSION_RE = SESSION_ID_RE
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SESSION_PREFIX_MASK = (1n << 48n) - 1n
const SESSION_TIME_MASK = (1n << 36n) - 1n

let lastTimestamp = 0
let sessionCounter = 0

function generateOpencodeId(prefix: 'ses' | 'msg', descending: boolean, now = Date.now(), counterValue = 1): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now
    sessionCounter = 0
  }
  if (prefix === 'ses') sessionCounter++
  const counter = prefix === 'ses' ? sessionCounter : counterValue
  const current = BigInt(now) * 0x1000n + BigInt(counter)
  const value = (descending ? ~current : current) & SESSION_PREFIX_MASK
  const timeHex = value.toString(16).padStart(12, '0')
  const random = randomBytes(14)
  let tail = ''
  for (const byte of random) tail += BASE62_CHARS[byte % 62]
  return `${prefix}_${timeHex}${tail}`
}

export function createSessionId(now = Date.now()): string {
  return generateOpencodeId('ses', true, now, 1)
}

export function createRequestId(now = Date.now()): string {
  return generateOpencodeId('msg', false, now)
}

/** Legacy alias for createRequestId. */
export function createOpencodeId(prefix: 'ses' | 'msg'): string {
  return prefix === 'ses' ? createSessionId() : createRequestId()
}

/** Get project ID from git remote (async). */
export async function getOpencodeProjectId(): Promise<string> {
  return 'global'
}

export function isRealOpencodeSession(id: string): boolean {
  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(id ?? '')
  return !!match && 0xfff - Number.parseInt(match[1], 16) < 16
}

const SESSIONS = new Map<string, string>()
const KEEP_SESSIONS = 1000

export function getSessionIdForRequest(
  headers: Headers,
  body: Record<string, unknown>
): string {
  let signal: string | null = null
  for (const name of [
    'x-opencode-session',
    'x-opencode-session-id',
    'x-session-affinity',
    'x-session-id',
    'conversation-id',
  ]) {
    const value = headers.get(name)
    if (value) { signal = value; break }
  }
  if (!signal && typeof body.metadata?.session_id === 'string') signal = body.metadata.session_id
  if (signal && isRealOpencodeSession(signal)) return signal

  if (!signal) {
    const messages = (body.messages ?? body.input) as unknown[]
    const first = Array.isArray(messages)
      ? messages.find((m: unknown) => (m as Record<string, unknown>)?.role === 'user')?.content
      : messages
    if (!first) return createSessionId()
    signal = JSON.stringify(first)
  }

  const key = createHash('sha256').update(`ses\0${signal}`).digest('hex')
  let session = SESSIONS.get(key)
  if (session) { SESSIONS.delete(key) }
  else {
    session = createSessionId()
    if (SESSIONS.size >= KEEP_SESSIONS) {
      const oldest = SESSIONS.keys().next().value
      if (oldest) SESSIONS.delete(oldest)
    }
  }
  SESSIONS.set(key, session)
  return session
}

export function getOpencodeUserAgent(protocol: 'chat' | 'responses' | 'anthropic' = 'chat'): string {
  return `opencode/${OPENCODE_CHANNEL}/${OPENCODE_VERSION}/${OPENCODE_CLIENT}`
}

export function getInferenceBaseUrl(url?: string): string {
  try {
    const parsed = new URL(url ?? DEFAULT_BASE)
    if (parsed.hostname !== 'opencode.ai' && !parsed.hostname.endsWith('.opencode.ai')) {
      return url ?? DEFAULT_BASE
    }
    if (!parsed.pathname.startsWith('/zen/')) return url ?? DEFAULT_BASE
    if (parsed.pathname.startsWith('/zen/go')) return url ?? DEFAULT_BASE
    parsed.pathname = '/inference' + parsed.pathname.slice(4)
    return parsed.toString()
  } catch { return url ?? DEFAULT_BASE }
}

export function buildOpencodeHeaders(
  protocol: 'chat' | 'responses' | 'anthropic',
  headers: Headers,
  body: Record<string, unknown>
): Headers {
  const session = getSessionIdForRequest(headers, body)
  const h = new Headers({
    'content-type': 'application/json',
    accept: '*/*',
    'user-agent': `opencode/${OPENCODE_CHANNEL}/${OPENCODE_VERSION}/${OPENCODE_CLIENT}`,
    'x-opencode-project': headers.get('x-opencode-project') || 'global',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-client': 'cli',
  })

  if (protocol === 'anthropic') {
    h.set('x-api-key', 'public')
    h.set('anthropic-version', headers.get('anthropic-version') ?? '2023-06-01')
    const beta = headers.get('anthropic-beta')
    if (beta) h.set('anthropic-beta', beta)
  } else {
    h.set('authorization', 'Bearer public')
  }

  return h
}

export function fingerprintToolKey(name: string): string {
  const trimmed = String(name ?? '').trim()
  return CORE_TOOLS.includes(trimmed as any) ? trimmed : ''
}

function chatFunctionOf(tool: unknown) {
  const fn = (tool as Record<string, unknown>)?.function
  return fn && typeof fn === 'object' && !Array.isArray(fn) ? fn : null
}

function isFingerprintDefinition(tool: unknown, key: string): boolean {
  const def = tool && (chatFunctionOf(tool) || tool)
  const want = FINGERPRINT_TOOL_DEFINITIONS[key as keyof typeof FINGERPRINT_TOOL_DEFINITIONS]
  return !!def && def.description === want.description
    && JSON.stringify(def.parameters) === JSON.stringify(want.parameters)
}

function toolNameOf(tool: unknown, protocol: 'chat' | 'responses' | 'anthropic'): string {
  if (protocol === 'chat') return chatFunctionOf(tool)?.name ?? ''
  return String((tool as Record<string, unknown>)?.name ?? '')
}

function withToolName(tool: unknown, name: string) {
  const fn = chatFunctionOf(tool)
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name }
}

function normalizeToolsForZen(
  body: Record<string, unknown>,
  protocol: 'chat' | 'responses' | 'anthropic'
): { declared: Set<string>; appended: string[]; aliasMap: Map<string, string> } {
  const tools = (body.tools as unknown[] | undefined) ?? []
  body.tools = tools
  const declared = new Set<string>()
  const taken = new Set<string>()
  const seen = new Set<string>()
  const aliasMap = new Map<string, string>()  // alias -> original name

  for (const tool of tools) {
    const name = toolNameOf(tool, protocol)
    if (typeof name === 'string') {
      taken.add(name)
    }
  }

  // Phase 1: Alias conflicting caller tools (exact name match but different definition)
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]
    const name = toolNameOf(tool, protocol)
    if (!name || !CORE_TOOLS.includes(name as any)) continue
    if (seen.has(name)) continue

    if (isFingerprintDefinition(tool, name as any)) {
      seen.add(name)
      continue
    }

    // Name collides with a fingerprint tool but definition differs → alias it
    let alias = `${name}_client`
    for (let n = 2; taken.has(alias); n++) alias = `${name}_client${n}`
    taken.add(alias)
    aliasMap.set(alias, name)
    tools[i] = withToolName(tool, alias)
    seen.add(alias)
  }

  // Phase 2: Append missing fingerprint tools with exact definitions
  const appended: string[] = []
  for (const name of CORE_TOOLS) {
    if (tools.some((tool) => toolNameOf(tool, protocol) === name)) continue
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name as keyof typeof FINGERPRINT_TOOL_DEFINITIONS]
    const tool = protocol === 'chat'
      ? { type: 'function', function: { name, description, parameters } }
      : protocol === 'anthropic'
        ? { name, description, input_schema: parameters }
        : { type: 'function', name, description, parameters }
    tools.push(tool)
    appended.push(name)
  }

  // Phase 3: Determine declared tools (after fingerprint injection)
  for (const tool of tools) {
    const name = toolNameOf(tool, protocol)
    if (typeof name === 'string') declared.add(name)
  }

  return { declared, appended, aliasMap }
}

/** Rename prior-turn calls to aliased tools so the model doesn't confuse them with OpenCode's. */
export function aliasHistoryToolCalls(
  body: Record<string, unknown>,
  aliasMap: Map<string, string>
): void {
  if (!aliasMap.size) return
  // aliasMap: alias -> original. We need original -> alias for history renaming.
  const originalToAlias = new Map<string, string>()
  for (const [alias, original] of aliasMap) originalToAlias.set(original, alias)

  if (Array.isArray(body.input)) {
    body.input = (body.input as Record<string, unknown>[]).map((item) => {
      if (item?.type === 'function_call' && typeof item.name === 'string') {
        const alias = originalToAlias.get(item.name)
        if (alias) return { ...item, name: alias }
      }
      return item
    })
  }

  if (Array.isArray(body.messages)) {
    body.messages = (body.messages as Record<string, unknown>[]).map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call: Record<string, unknown>) => {
          const fn = call.function as Record<string, unknown> | undefined
          if (!fn || typeof fn.name !== 'string') return call
          const alias = originalToAlias.get(fn.name)
          if (!alias) return call
          return { ...call, function: { ...fn, name: alias } }
        }),
      }
    })
  }
}

/** Restore aliased tool names in the response to the caller's original names. */
export function restoreToolNames(
  body: Record<string, unknown>,
  aliasMap: Map<string, string>
): void {
  if (!aliasMap.size) return

  // Restore tool_calls in messages (chat shape)
  if (Array.isArray(body.messages)) {
    body.messages = (body.messages as Record<string, unknown>[]).map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call: Record<string, unknown>) => {
          const fn = call.function as Record<string, unknown> | undefined
          if (!fn || typeof fn.name !== 'string') return call
          const original = aliasMap.get(fn.name)
          if (!original) return call
          return { ...call, function: { ...fn, name: original } }
        }),
      }
    })
  }

  // Restore function_call items in input (Responses shape)
  if (Array.isArray(body.input)) {
    body.input = (body.input as Record<string, unknown>[]).map((item) => {
      if (item?.type === 'function_call' && typeof item.name === 'string') {
        const original = aliasMap.get(item.name)
        if (original) return { ...item, name: original }
      }
      if (item?.type === 'function_call_output') {
        // function_call_output uses call_id, not name — nothing to restore
      }
      return item
    })
  }
}

export {
  CORE_TOOLS,
  FINGERPRINT_TOOL_DEFINITIONS,
  normalizeToolsForZen,
  OPENCODE_SESSION_RE,
}