import { openai } from './openai.js'
import { custom } from './custom.js'
import type { ProviderId } from '../types.js'

export const providers = {
  openai,
  custom,
} as const

export function getProviderDef(id: ProviderId) {
  if (id === 'openai') return openai
  if (id === 'custom') return custom
  return undefined
}
