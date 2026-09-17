import { createHash } from 'crypto'
import { getRemoteUrl, normalizeGitRemoteUrl } from '../../utils/git.js'

const DEFAULT_OPENCODE_VERSION = '1.18.31'

let opencodeVersion = process.env.OPENCODE_VERSION || DEFAULT_OPENCODE_VERSION
let opencodeUserAgent = buildUserAgent(opencodeVersion)

function buildUserAgent(version: string): string {
  return `opencode/local/${version}/cli`
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

/** Generate IDs using OpenCode's descending/ascending identifier format. */
export function createOpencodeId(prefix: 'ses' | 'msg'): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const current = BigInt(Date.now()) * 0x1000n + 1n
  const timestamp = Array.from({ length: 6 }, (_, index) =>
    Number((current >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0'),
  ).join('')
  const random = crypto.getRandomValues(new Uint8Array(14))
  return `${prefix}_${timestamp}${Array.from(random, (byte) => chars[byte % chars.length]).join('')}`
}

export function setOpencodeVersion(version: string): void {
  if (!version) return
  opencodeVersion = version
  opencodeUserAgent = buildUserAgent(version)
}

export function getOpencodeUserAgent(): string {
  return opencodeUserAgent
}
