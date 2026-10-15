import { createHash, getRandomValues } from 'crypto'
import { getRemoteUrl, normalizeGitRemoteUrl } from '../../utils/git.js'

// OpenCode 1.19.0+ required for free tier (since mid-Oct 2026)
const DEFAULT_OPENCODE_VERSION = '1.19.0'

let opencodeVersion = process.env.OPENCODE_VERSION || DEFAULT_OPENCODE_VERSION
let opencodeUserAgent = buildUserAgent(opencodeVersion)

function buildUserAgent(version: string): string {
  // Match real OpenCode 1.19.0 UA exactly (incl. ai-sdk + Bun)
  return `opencode/${version} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`
}

const PROJECT_ID_FALLBACK = 'global'
let projectIdPromise: Promise<string> | undefined

/** OpenCode sends its stable repository identity to Zen, not the literal "global". */
export function getOpencodeProjectId(): Promise<string> {
  if (!projectIdPromise) {
    projectIdPromise = getRemoteUrl()
      .then((remote) => {
        const normalized = remote ? normalizeGitRemoteUrl(remote) : undefined
        return normalized
          ? createHash('sha1').update(`git-remote:${normalized}`).digest('hex')
          : PROJECT_ID_FALLBACK
      })
      .catch(() => PROJECT_ID_FALLBACK)
  }
  return projectIdPromise
}

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// OpenCode session ID regex with counter validation (low 12 bits < 16)
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

let lastTimestamp = 0
let counter = 0

function unstableRandom14(): string {
  const bytes = new Uint8Array(14)
  getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < 14; i++) {
    out += BASE62_CHARS[bytes[i] % 62]
  }
  return out
}

function generateId(prefix: 'ses' | 'msg', descending: boolean, timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const timeHex = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0'),
  ).join('')
  return `${prefix}_${timeHex}${unstableRandom14()}`
}

/** Generate session ID: descending timestamp (canonical OpenCode format). */
export function createSessionId(timestamp?: number): string {
  return generateId('ses', true, timestamp)
}

/** Generate request ID: ascending timestamp. */
export function createRequestId(timestamp?: number): string {
  return generateId('msg', false, timestamp)
}

/**
 * Check if a session ID is a real OpenCode session (validates counter in low 12 bits).
 * Zen's free tier rejects IDs that don't match OpenCode's format.
 */
export function isRealOpencodeSession(id: string): boolean {
  if (!id?.startsWith('ses_') || !OPENCODE_SESSION_RE.test(id)) {
    return false
  }
  // Validate low 12 bits (chars 13-15) < 16 (OpenCode's counter check)
  const lowHex = id.slice(13, 16)
  const low = parseInt(lowHex, 16)
  return !isNaN(low) && low < 16
}

/**
 * Deterministically translate a foreign session identity into a valid
 * OpenCode canonical ses_... ID. Preserves valid native sessions.
 * This ensures multi-turn prompt caching is preserved upstream.
 */
export function translateSessionId(foreignId: string, clientTool = 'codev'): string {
  const trimmed = foreignId?.trim?.() ?? ''
  if (OPENCODE_SESSION_RE.test(trimmed) && isRealOpencodeSession(trimmed)) {
    return trimmed
  }

  const digest = createHash('sha256')
    .update(`opencode\0${clientTool}\0${trimmed}`)
    .digest()
  const timeHex = digest.subarray(0, 6).toString('hex')
  let randomPart = ''
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62]
  }
  // Ensure low 12 bits < 16 to pass Zen's validation
  const low = parseInt(randomPart.slice(0, 3), 36) & 0xfff
  const adjustedLow = low % 16
  randomPart = adjustedLow.toString(16).padStart(3, '0') + randomPart.slice(3)
  return `ses_${timeHex}${randomPart}`
}

/** Backward-compatible wrapper: ses_ = descending, msg_ = ascending. */
export function createOpencodeId(prefix: 'ses' | 'msg'): string {
  return prefix === 'ses' ? createSessionId() : createRequestId()
}

export function setOpencodeVersion(version: string): void {
  if (!version) return
  opencodeVersion = version
  opencodeUserAgent = buildUserAgent(version)
}

export function getOpencodeUserAgent(): string {
  return opencodeUserAgent
}

/**
 * Real OpenCode tool schemas (1.19.0). Zen's free tier requires these exact
 * parameters — empty stubs {"type":"object","properties":{}} are rejected.
 */
export const OPENCODE_TOOL_SCHEMAS: Record<string, string> = {
  bash: JSON.stringify({
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'integer', description: 'Optional timeout in milliseconds' },
      workdir: { type: 'string', description: 'The working directory to run the command in' },
    },
    required: ['command'],
  }),
  read: JSON.stringify({
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'The absolute path to the file or directory to read' },
      offset: { type: 'integer', description: 'The line number to start reading from (1-indexed)' },
      limit: { type: 'integer', description: 'The maximum number of lines to read' },
    },
    required: ['filePath'],
  }),
}

/** Fingerprint tools required by OpenCode free tier (bash + read minimum). */
export const FINGERPRINT_TOOLS = ['bash', 'read']

/** Rewrite /zen/v1... to /inference/v1... for free tier (Zen requirement since mid-Oct 2026). */
export function rewriteOpencodeFreeUrl(url: string): string {
  try {
    const pu = new URL(url)
    if (pu.hostname !== 'opencode.ai' && !pu.hostname.endsWith('.opencode.ai')) {
      return url
    }
    if (!pu.pathname.startsWith('/zen/')) {
      return url
    }
    // Skip /zen/go (Go subscription endpoint)
    if (pu.pathname.startsWith('/zen/go')) {
      return url
    }
    pu.pathname = '/inference' + pu.pathname.slice(4) // /zen -> /inference
    return pu.toString()
  } catch {
    return url
  }
}