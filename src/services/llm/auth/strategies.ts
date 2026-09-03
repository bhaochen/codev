/**
 * Auth Strategies — Phase 7 minimal abstraction.
 * Provider and Protocol are decoupled from credential resolution.
 * Strategy only knows how to produce a Credential; caller converts to headers.
 */
import type { ProviderId } from '../types.js'

export type Credential = { type: 'bearer'; token: string } | { type: 'api-key'; key: string; headerName?: string } | { type: 'none' }

export interface AuthStrategy {
  /** Stable id for diagnostics (bearer / none / api-key ...) */
  id: string
  resolve(provider: ProviderId): Credential
}

export function createBearerStrategy(
  getToken: () => string | null,
  opts?: { fallbackToken?: string },
): AuthStrategy {
  const fallback = opts?.fallbackToken
  return {
    id: 'bearer',
    resolve() {
      try {
        const token = getToken()
        if (token) return { type: 'bearer', token }
        if (fallback) return { type: 'bearer', token: fallback }
        return { type: 'none' }
      } catch {
        return fallback ? { type: 'bearer', token: fallback } : { type: 'none' }
      }
    },
  }
}

export function createApiKeyStrategy(
  getKey: () => string | null,
  headerName = 'x-api-key',
): AuthStrategy {
  return {
    id: 'api-key',
    resolve() {
      try {
        const key = getKey()
        if (key) return { type: 'api-key', key, headerName }
        return { type: 'none' }
      } catch {
        return { type: 'none' }
      }
    },
  }
}

export const noneStrategy: AuthStrategy = {
  id: 'none',
  resolve() {
    return { type: 'none' }
  },
}

/** Convert Credential to Authorization header value. `none` → null (caller decides fallback). */
export function credentialToHeader(cred: Credential): string | null {
  if (cred.type === 'bearer') return `Bearer ${cred.token}`
  return null
}

/** Build headers object from Credential (bearer → Authorization, api-key → x-api-key). */
export function credentialToHeaders(cred: Credential): Record<string, string> {
  if (cred.type === 'bearer') return { Authorization: `Bearer ${cred.token}` }
  if (cred.type === 'api-key') return { [cred.headerName ?? 'x-api-key']: cred.key }
  return {}
}
