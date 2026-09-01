import { anthropic } from './anthropic.js'
import { openai } from './openai.js'
import { opencode } from './opencode.js'
import { nvidia } from './nvidia.js'
import { local } from './local.js'
import { bedrock } from './bedrock.js'
import { vertex } from './vertex.js'
import { foundry } from './foundry.js'
import type { ProviderId } from '../types.js'

export const providers = {
  firstParty: anthropic,
  openai,
  opencode,
  nvidia,
  local,
  bedrock,
  vertex,
  foundry,
} as const

// firstParty 为 anthropic 的规范 id，anthropic 为兼容别名
const alias: Partial<Record<ProviderId, ProviderId>> = {
  anthropic: 'firstParty',
}

export function getProviderDef(id: ProviderId) {
  const normalized = (alias[id] ?? id) as keyof typeof providers
  return (providers as Record<string, unknown>)[normalized] as (typeof providers)[keyof typeof providers] | undefined
}
