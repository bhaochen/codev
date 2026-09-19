import { createHash, getRandomValues } from 'crypto'
import { getRemoteUrl, normalizeGitRemoteUrl } from '../../utils/git.js'

const DEFAULT_OPENCODE_VERSION = '1.18.31'

let opencodeVersion = process.env.OPENCODE_VERSION || DEFAULT_OPENCODE_VERSION
let opencodeUserAgent = buildUserAgent(opencodeVersion)

function buildUserAgent(version: string): string {
  return `opencode/${version}`
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
 * Deterministically translate a foreign session identity into a valid
 * OpenCode canonical ses_... ID. Preserves valid native sessions.
 * This ensures multi-turn prompt caching is preserved upstream.
 */
export function translateSessionId(foreignId: string, clientTool = 'codev'): string {
  const trimmed = foreignId?.trim?.() ?? ''
  if (OPENCODE_SESSION_RE.test(trimmed)) return trimmed

  const digest = createHash('sha256')
    .update(`opencode\0${clientTool}\0${trimmed}`)
    .digest()
  const timeHex = digest.subarray(0, 6).toString('hex')
  let randomPart = ''
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62]
  }
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

/** Fingerprint tools required by OpenCode free tier (#4132). */
export const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']
