import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { APIProvider } from './providers.js'

type CatalogProvider = 'openrouter' | 'opencode' | 'nvidia'
type ContextWindowEntry = {
  contextWindow: number
  promptLimit?: number
}
type ContextWindowStore = {
  version: 1
  providers: Partial<Record<CatalogProvider, Record<string, number>>>
}

const STORE_FILENAME = 'model-context-windows.json'
const MAX_MODELS_PER_PROVIDER = 2_000
const WRITE_DELAY_MS = 100
let cachedPath: string | undefined
let cachedStore: ContextWindowStore | undefined
let pendingProviders: Partial<Record<CatalogProvider, Record<string, number>>> = {}
let writeTimer: ReturnType<typeof setTimeout> | undefined
let writePromise: Promise<void> = Promise.resolve()

function getStorePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', STORE_FILENAME)
}

function loadStore(): ContextWindowStore {
  const path = getStorePath()
  if (cachedPath === path && cachedStore) return cachedStore

  cachedPath = path
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ContextWindowStore
    if (parsed.version === 1 && parsed.providers && typeof parsed.providers === 'object') {
      cachedStore = parsed
      return parsed
    }
  } catch {
    // Missing or invalid cache files are treated as an empty cache.
  }

  cachedStore = { version: 1, providers: {} }
  return cachedStore
}

function normalizeModelId(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').toLowerCase()
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    const providers = pendingProviders
    pendingProviders = {}
    writePromise = writePromise.then(async () => {
      const store = loadStore()
      store.providers = { ...store.providers, ...providers }
      const path = getStorePath()
      const temporaryPath = `${path}.${process.pid}.tmp`
      try {
        await mkdir(join(getClaudeConfigHomeDir(), 'cache'), { recursive: true })
        await writeFile(temporaryPath, JSON.stringify(store), { mode: 0o600 })
        await rename(temporaryPath, path)
      } catch (error) {
        try {
          const { unlink } = await import('node:fs/promises')
          await unlink(temporaryPath)
        } catch {
          // Preserve the original write failure.
        }
        throw error
      }
    }).catch(error => {
      console.error('[contextWindowStore] Failed to persist provider context windows:', error)
    })
  }, WRITE_DELAY_MS)
}

export function getStoredProviderContextWindow(
  provider: APIProvider | null,
  model: string,
): number | undefined {
  if (!provider || provider === 'local') return undefined
  if (provider !== 'openrouter' && provider !== 'opencode' && provider !== 'nvidia') {
    return undefined
  }
  const windows = loadStore().providers[provider]
  const contextWindow = windows?.[normalizeModelId(model)]
  return Number.isSafeInteger(contextWindow) && (contextWindow ?? 0) > 0
    ? contextWindow
    : undefined
}

export function recordProviderContextWindows(
  provider: CatalogProvider,
  entries: Array<{ id: string } & ContextWindowEntry>,
): void {
  const windows: Record<string, number> = {}
  for (const entry of entries) {
    if (!entry.id || !Number.isFinite(entry.contextWindow) || entry.contextWindow <= 0) {
      continue
    }
    const promptLimit =
      Number.isFinite(entry.promptLimit) && (entry.promptLimit ?? 0) > 0
        ? entry.promptLimit
        : undefined
    windows[normalizeModelId(entry.id)] = Math.floor(
      promptLimit ? Math.min(entry.contextWindow, promptLimit) : entry.contextWindow,
    )
  }

  const trimmed = Object.fromEntries(
    Object.entries(windows).slice(0, MAX_MODELS_PER_PROVIDER),
  )
  loadStore().providers[provider] = trimmed
  pendingProviders[provider] = trimmed
  scheduleWrite()
}

export async function flushContextWindowStoreForTests(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = undefined
    const providers = pendingProviders
    pendingProviders = {}
    writePromise = writePromise.then(async () => {
      const store = loadStore()
      store.providers = { ...store.providers, ...providers }
      const path = getStorePath()
      await mkdir(join(getClaudeConfigHomeDir(), 'cache'), { recursive: true })
      await writeFile(path, JSON.stringify(store), { mode: 0o600 })
    })
  }
  await writePromise
}

export function resetContextWindowStoreForTests(): void {
  cachedPath = undefined
  cachedStore = undefined
  pendingProviders = {}
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = undefined
  writePromise = Promise.resolve()
}
