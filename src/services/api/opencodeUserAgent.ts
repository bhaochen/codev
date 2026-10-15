import { createHash, randomBytes } from 'crypto'

// OpenCode 1.19.0+ required for free tier (since mid-Oct 2026)
const OPENCODE_VERSION = '1.19.0'

// Provider-utils versions per protocol (from OpenCode 1.19.0 release binary)
const PROVIDER_UTILS = {
  chat: '4.0.23',
  responses: '4.0.40',
  anthropic: '4.0.46',
} as const

// Zen free tier endpoints (since mid-Oct 2026)
const DEFAULT_BASE = 'https://opencode.ai/inference/v1'
const LEGACY_BASE = 'https://opencode.ai/zen/v1'

// Tools Zen's free tier requires (5 tools, each with a required parameter)
const CORE_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'] as const

const CORE_PARAMETER: Record<string, string> = {
  bash: 'command',
  edit: 'filePath',
  glob: 'pattern',
  grep: 'pattern',
  read: 'filePath',
}

// Session ID validation regex with counter (low 12 bits inverted < 16)
const SESSION_ID_RE = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

let lastTimestamp = 0
let sessionCounter = 0
let requestCounter = 0

/**
 * Generate an OpenCode-style ID (session or request).
 * Format: prefix_ + 12 hex of (timestamp * 0x1000 + counter) + 14 random base62
 * For sessions: counter is bit-inverted (descending) so newer sorts first.
 */
function generateOpencodeId(prefix: 'ses' | 'msg', descending: boolean, now = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now
    if (prefix === 'ses') sessionCounter = 0
    else requestCounter = 0
  }
  const counter = prefix === 'ses' ? ++sessionCounter : ++requestCounter
  const current = BigInt(now) * 0x1000n + BigInt(counter)
  const value = (descending ? ~current : current) & 0xffffffffffffn
  const random = randomBytes(14)
  let tail = ''
  for (const byte of random) tail += ALPHABET[byte % 62]
  return `${prefix}_${value.toString(16).padStart(12, '0')}${tail}`
}

/** Generate a session ID (descending timestamp). */
export function createSessionId(now = Date.now()): string {
  return generateOpencodeId('ses', true, now)
}

/** Generate a request ID (ascending timestamp). */
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

/** Check if a session ID is a real OpenCode session (counter in low 12 bits < 16). */
export function isRealOpencodeSession(id: string): boolean {
  const match = SESSION_ID_RE.exec(id ?? '')
  return !!match && 0xfff - Number.parseInt(match[1], 16) < 16
}

// Stable session per conversation (LRU cache, max 1000)
const SESSIONS = new Map<string, string>()
const KEEP_SESSIONS = 1000

/**
 * Get or create a stable session ID for a conversation.
 * Reads from multiple headers; falls back to hash of first user message.
 */
export function getSessionIdForRequest(
  headers: Headers,
  body: Record<string, unknown>
): string {
  // Read session from various headers (in priority order)
  let signal: string | null = null
  for (const name of [
    'x-opencode-session',
    'x-opencode-session-id',
    'x-session-affinity',
    'x-session-id',
    'conversation-id',
  ]) {
    const value = headers.get(name)
    if (value) {
      signal = value
      break
    }
  }
  // Fallback to body metadata
  if (!signal && typeof body.metadata?.session_id === 'string') {
    signal = body.metadata.session_id
  }
  // Use existing valid session ID
  if (signal && isRealOpencodeSession(signal)) return signal

  // No signal or invalid: create stable session keyed by first user message
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
  if (session) {
    // Move to end (LRU)
    SESSIONS.delete(key)
  } else {
    session = createSessionId()
    if (SESSIONS.size >= KEEP_SESSIONS) {
      const oldest = SESSIONS.keys().next().value
      if (oldest) SESSIONS.delete(oldest)
    }
  }
  SESSIONS.set(key, session)
  return session
}

/** Get User-Agent matching OpenCode 1.19.0 per protocol. */
export function getOpencodeUserAgent(protocol: 'chat' | 'responses' | 'anthropic' = 'chat'): string {
  return `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/${PROVIDER_UTILS[protocol]} runtime/bun/1.3.14`
}

/** Real OpenCode tool schemas (exact parameters Zen's free tier expects). */
export const OPENCODE_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  bash: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'integer', description: 'Optional timeout in milliseconds' },
      workdir: { type: 'string', description: 'The working directory to run the command in' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  edit: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'The file to edit' },
      oldString: { type: 'string', description: 'The text to replace' },
      newString: { type: 'string', description: 'The text to replace it with' },
    },
    required: ['filePath', 'oldString', 'newString'],
    additionalProperties: false,
  },
  glob: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  grep: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regex pattern to search for' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  read: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'The absolute path to the file or directory to read' },
      offset: { type: 'integer', description: 'The line number to start reading from (1-indexed)' },
      limit: { type: 'integer', description: 'The maximum number of lines to read' },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
}

/** Get tool schema for Zen free tier (includes "Not available" description). */
export function getZenToolSchema(name: string): Record<string, unknown> {
  const base = OPENCODE_TOOL_SCHEMAS[name]
  return base
    ? { ...base, properties: { ...base.properties, [CORE_PARAMETER[name]]: base.properties[CORE_PARAMETER[name]] } }
    : { type: 'object', properties: {} }
}

/** Normalize tools for Zen free tier: inject missing CORE_TOOLS with proper schemas. */
export function normalizeToolsForZen(
  body: Record<string, unknown>,
  protocol: 'chat' | 'responses' | 'anthropic'
): { declared: Set<string> } {
  const tools = (body.tools as unknown[] | undefined) ?? []
  body.tools = tools

  const declared = new Set<string>()
  const present = new Set<string>()

  for (const tool of tools) {
    const name = protocol === 'chat'
      ? (tool as Record<string, unknown>)?.function?.name
      : (tool as Record<string, unknown>)?.name
    if (typeof name === 'string') {
      present.add(name)
      declared.add(name)
    }
  }

  for (const name of CORE_TOOLS) {
    if (present.has(name)) continue

    const paramName = CORE_PARAMETER[name]
    const parameters = {
      type: 'object',
      properties: { [paramName]: { type: 'string' } },
      additionalProperties: false,
    }
    const definition = { name, description: 'Not available. Never call this tool.' }

    const tool = protocol === 'chat'
      ? { type: 'function', function: { ...definition, parameters } }
      : protocol === 'anthropic'
        ? { ...definition, input_schema: parameters }
        : { type: 'function', ...definition, parameters }

    tools.push(tool)
  }

  return { declared }
}

/** Get the inference API base URL (not legacy zen/v1). */
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
  } catch {
    return url ?? DEFAULT_BASE
  }
}

/** Build headers matching OpenCode 1.19.0 exactly. */
export function buildOpencodeHeaders(
  protocol: 'chat' | 'responses' | 'anthropic',
  headers: Headers,
  body: Record<string, unknown>,
  projectId?: string
): Headers {
  const session = getSessionIdForRequest(headers, body)
  const requestId = generateOpencodeId('msg', false)

  const h = new Headers({
    'content-type': 'application/json',
    accept: '*/*',
    'user-agent': getOpencodeUserAgent(protocol),
    'x-opencode-project':
      headers.get('x-opencode-project') ||
      (projectId ? projectId : 'global'),
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-opencode-request': generateOpencodeId('msg', false),
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