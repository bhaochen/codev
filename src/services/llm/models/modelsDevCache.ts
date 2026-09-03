/**
 * models.dev cache — Phase 12D: remote sync with local disk cache.
 * Pure fetch + atomic write, no Provider/Protocol/Auth coupling.
 * Reuses Claude config home for cache file (no new ~/.codev).
 */
import { homedir } from 'os'
import { join, dirname } from 'path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { registerModelsDev } from './registry.js'

const MODELS_DEV_URL = 'https://models.dev/models.json'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24h

function getCachePath(): string {
  if (process.env.CODEV_MODELS_CACHE_PATH) return process.env.CODEV_MODELS_CACHE_PATH
  // Reuse Claude config dir — no ~/.codev, XDG compatible
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  // Prefer XDG cache, fallback to Claude config dir for minimal new top-level
  try {
    // Use XDG cache if available, else home
    return join(base, 'codev', 'models.json')
  } catch {
    return join(getClaudeConfigHomeDir(), 'models-dev-cache.json')
  }
}

function isFresh(mtimeMs: number, ttlMs: number): boolean {
  return Date.now() - mtimeMs < ttlMs
}

async function ensureDir(path: string): Promise<void> {
  const { mkdir } = await import('fs/promises')
  await mkdir(dirname(path), { recursive: true })
}

async function readCacheFile(path: string): Promise<unknown | null> {
  try {
    const { readFile, stat } = await import('fs/promises')
    const st = await stat(path)
    if (!st.isFile()) return null
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function writeCacheFile(path: string, data: unknown): Promise<void> {
  const { writeFile, rename } = await import('fs/promises')
  await ensureDir(path)
  const tmp = `${path}.tmp.${Date.now()}`
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  await rename(tmp, path)
}

/** Load cache if exists and fresh (TTL), register into Registry. */
export async function loadModelsDevCache(opts?: { ttlMs?: number; cachePath?: string }): Promise<{ hit: boolean; added: number }> {
  const path = opts?.cachePath ?? getCachePath()
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS
  try {
    const { stat } = await import('fs/promises')
    const st = await stat(path)
    if (!isFresh(st.mtimeMs, ttl)) return { hit: false, added: 0 }
    const data = await readCacheFile(path)
    if (!data || typeof data !== 'object') return { hit: false, added: 0 }
    const values = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>)
    const { added } = registerModelsDev(values as unknown[])
    return { hit: true, added }
  } catch {
    return { hit: false, added: 0 }
  }
}

/** Fetch from models.dev, save to cache, register. */
export async function fetchAndCacheModelsDev(opts?: {
  fetchFn?: typeof fetch
  cachePath?: string
  url?: string
}): Promise<{ fetched: number; added: number }> {
  const fetchFn = opts?.fetchFn ?? (globalThis.fetch as typeof fetch)
  const url = opts?.url ?? MODELS_DEV_URL
  const path = opts?.cachePath ?? getCachePath()

  const res = await fetchFn(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`models.dev fetch failed (${res.status})`)
  const data = (await res.json()) as Record<string, unknown>
  // models.json is Record<id, model>, catalog is {models:...}
  const rawList: unknown[] = Array.isArray(data)
    ? data
    : (data as { models?: Record<string, unknown> }).models
      ? Object.values((data as { models: Record<string, unknown> }).models)
      : Object.values(data)

  await writeCacheFile(path, data)
  const { added } = registerModelsDev(rawList)
  return { fetched: rawList.length, added }
}

/** Startup sync: try cache first, then background fetch (non-blocking if requested). */
export async function syncModelsDevCache(opts?: {
  fetchFn?: typeof fetch
  cachePath?: string
  ttlMs?: number
  background?: boolean
}): Promise<{ cacheHit: boolean; cacheAdded: number; fetched?: number; added?: number }> {
  const cacheRes = await loadModelsDevCache({ ttlMs: opts?.ttlMs, cachePath: opts?.cachePath })
  if (opts?.background) {
    // fire-and-forget fetch
    fetchAndCacheModelsDev({ fetchFn: opts?.fetchFn, cachePath: opts?.cachePath }).catch(() => {})
    return { cacheHit: cacheRes.hit, cacheAdded: cacheRes.added }
  }
  // If cache missed or stale, fetch synchronously (failure is non-fatal)
  if (!cacheRes.hit) {
    try {
      const fetched = await fetchAndCacheModelsDev({ fetchFn: opts?.fetchFn, cachePath: opts?.cachePath })
      return { cacheHit: false, cacheAdded: cacheRes.added, fetched: fetched.fetched, added: fetched.added }
    } catch {
      return { cacheHit: false, cacheAdded: cacheRes.added }
    }
  }
  return { cacheHit: cacheRes.hit, cacheAdded: cacheRes.added }
}

export const __test__ = { getCachePath, isFresh }
