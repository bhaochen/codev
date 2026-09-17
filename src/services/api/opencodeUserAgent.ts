const DEFAULT_OPENCODE_VERSION = '1.18.31'
const AI_SDK_PROVIDER = '@ai-sdk/openai-compatible'
const AI_SDK_PROVIDER_UTILS = 'ai-sdk/provider-utils/4.0.23'

let opencodeVersion = process.env.OPENCODE_VERSION || DEFAULT_OPENCODE_VERSION
let opencodeUserAgent = buildUserAgent(opencodeVersion)

function buildUserAgent(version: string, provider = AI_SDK_PROVIDER): string {
  const bunVersion = typeof Bun !== 'undefined' ? Bun.version : '1.3.14'
  return `opencode/${version} ${provider} ${AI_SDK_PROVIDER_UTILS} runtime/bun/${bunVersion}`
}

export function setOpencodeVersion(version: string, provider = AI_SDK_PROVIDER): void {
  if (!version) return
  opencodeVersion = version
  opencodeUserAgent = buildUserAgent(version, provider)
}

export function getOpencodeUserAgent(): string {
  return opencodeUserAgent
}
