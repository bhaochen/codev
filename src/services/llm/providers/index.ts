import { openai } from './openai.js'
import type { ProviderId } from '../types.js'

export const providers = {
  openai,
} as const

export function getProviderDef(id: ProviderId) {
  return id === 'openai' ? openai : undefined
}
