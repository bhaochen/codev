/**
 * What we KNOW about a model's image support, per (provider, model).
 *
 * Deliberately not a hardcoded list. "OpenAI-compatible" is a transport, not a
 * capability: Kimi, Qwen-VL, GPT-4o, Gemini and Llama-4 all speak it, and some
 * of them see images perfectly well. Treating the whole endpoint as blind is
 * as wrong as assuming every model can see.
 *
 * Three states, and the third one matters:
 *   true      the provider told us the model takes image input
 *   false     the provider told us it does not
 *   undefined we have not been told
 *
 * Only `true` unlocks sending pixels. `false` and `undefined` fall back to
 * text, which every provider on earth accepts — so a wrong guess can never
 * break a request, at worst it weakens the answer.
 *
 * Evidence comes from the same catalogs the /models picker already fetches
 * (models.dev `attachment` + `modalities.input`, OpenRouter
 * `architecture.input_modalities`). Findings persist to disk, so a model seen
 * yesterday is still known today.
 */

import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'

const memo = new Map<string, boolean>()
let loaded = false
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function keyFor(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}::${model.trim().toLowerCase()}`
}

function storePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'vision-capability.json')
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as {
      models?: Record<string, boolean>
    }
    for (const [k, v] of Object.entries(parsed.models ?? {})) {
      if (typeof v === 'boolean') memo.set(k, v)
    }
  } catch {
    /* first run, or an unreadable cache — start empty */
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (!dirty) return
    dirty = false
    try {
      const path = storePath()
      void mkdir(dirname(path), { recursive: true })
        .then(() =>
          writeFile(
            path,
            JSON.stringify({ v: 1, models: Object.fromEntries(memo) }),
            'utf8',
          ),
        )
        .catch(() => {})
    } catch {
      /* best effort */
    }
  }, 2_000)
  // Never hold the process open for a cache write.
  flushTimer.unref?.()
}

/** Record what a provider catalog told us. Later evidence wins. */
export function recordModelVision(
  provider: string | undefined,
  model: string | undefined,
  capable: boolean,
): void {
  if (!provider || !model) return
  load()
  const key = keyFor(provider, model)
  if (memo.get(key) === capable) return
  memo.set(key, capable)
  dirty = true
  scheduleFlush()
}

/**
 * Derive vision from a models.dev-shaped catalog entry: `attachment: true`
 * plus an image/pdf entry in `modalities.input`. Returns undefined when the
 * entry carries no modality evidence at all, so a bare catalog cannot record
 * a false negative.
 */
export function visionFromModelsDevEntry(raw: {
  attachment?: unknown
  modalities?: { input?: unknown } | undefined
}): boolean | undefined {
  if (typeof raw.attachment !== 'boolean') return undefined
  if (raw.attachment !== true) return false
  const input = raw.modalities?.input
  if (!Array.isArray(input)) return false
  return input.some(m => m === 'image' || m === 'pdf')
}

/**
 * `true` only when a provider positively said so. Sync and cheap: the caller
 * is a message converter on the hot path.
 */
export function modelAcceptsImages(
  provider: string | undefined,
  model: string | undefined,
): boolean | undefined {
  if (!provider || !model) return undefined
  load()

  const direct = memo.get(keyFor(provider, model))
  if (direct !== undefined) return direct

  // OpenRouter-style suffixes (`:free`, `:nitro`) and provider-prefixed ids
  // describe routing, not modality — fall back to the bare id.
  const bare = model.replace(/:(free|nitro|floor|online|extended)$/i, '')
  if (bare !== model) {
    const stripped = memo.get(keyFor(provider, bare))
    if (stripped !== undefined) return stripped
  }

  // Same model id learned under a different provider (gateways resell the
  // same weights, and the models.dev catalog is the richest source).
  const suffix = `::${bare.trim().toLowerCase()}`
  for (const [k, v] of memo) {
    if (k.endsWith(suffix)) return v
  }
  return undefined
}

export function _resetVisionCapabilityForTest(): void {
  memo.clear()
  loaded = true
}
