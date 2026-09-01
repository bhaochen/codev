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
  anthropic,
  openai,
  opencode,
  nvidia,
  local,
  bedrock,
  vertex,
  foundry,
} as const

export function getProviderDef(id: ProviderId) {
  return providers[id]
}
