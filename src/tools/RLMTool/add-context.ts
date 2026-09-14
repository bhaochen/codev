/**
 * add_context handler: resolves a source (local path) on the host, writes the payload to a
 * temp file, and returns the metadata the worker needs to append into its `context` list.
 *
 * Simplified port of rlm.pi/pi-plugin/rlm/src/bridge/add-context.ts: no RlmEmitter (UI tree
 * panel), no anydoc document conversion, no git shallow clone — local paths only.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SubcallHandlers, AddContextResult } from './interrupts.js'
import { resolveSource, contextSourceId, pathPrefixFor, isSensitivePath } from './resolve.js'

export interface AddContextHandlerOpts {
  readonly cwd: string
  readonly signal?: AbortSignal
}

export const NO_FILES_PRODUCED = 'add_context produced no files'
const LIST_CONTEXT_REQUIRED = (kind: string): string =>
  `add_context requires list context (file bundle); got ${kind}`

const PY_TYPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  string: 'str',
  boolean: 'bool',
  number: 'int',
  bigint: 'int',
  undefined: 'None',
})

function pythonKindOf(value: unknown): string {
  if (value === null) return 'None'
  return PY_TYPE_NAMES[typeof value] ?? 'dict'
}

function absKey(path: string): string {
  const resolved = resolve(path)
  return resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))
    ? resolved.slice(0, -1)
    : resolved
}

function alreadyLoadedResult(sourceId: string, pathPrefix: string): AddContextResult {
  return Object.freeze({
    payload: Object.freeze([]),
    files: 0,
    chars: 0,
    sourceId,
    pathPrefix,
    alreadyLoaded: true,
    documents: 0,
    converted: 0,
    skipped: Object.freeze([]),
  })
}

/**
 * True when the live context already holds un-prefixed entries under `relPrefix`.
 * Used so add_context("./src/context") does not double-load a subpath the cwd seed
 * already has (without blocking gitignored subtrees that the seed never had).
 */
function contextHasUnprefixedUnder(context: unknown, relPrefix: string): boolean {
  if (!Array.isArray(context) || relPrefix === '') return false
  const clean = relPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (clean === '' || clean.startsWith('..')) return false
  const withSlash = `${clean}/`
  for (let i = 0; i < context.length; i++) {
    const entry: unknown = context[i]
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.path !== 'string') continue
    if (e.path.startsWith('ctx/')) continue
    if (e.path === clean || e.path.startsWith(withSlash)) return true
  }
  return false
}

export interface AddContextBundle {
  readonly handlers: Pick<SubcallHandlers, 'addContext'>
  readonly markLoaded: (prefix: string) => void
  readonly markSeededCwd: (absPath: string) => void
  readonly loadedPrefixes: () => ReadonlySet<string>
  readonly seededCwd: () => string | undefined
}

export function buildAddContextHandler(
  opts: AddContextHandlerOpts,
  /** Read the live context to refuse pre-flight exactly what the worker's _append_context would reject. */
  getContext?: () => unknown,
  /** Post-load hook: the engine grows its liveContext here. */
  onLoaded?: (payload: readonly { readonly path: string; readonly content: string }[]) => void | Promise<void>,
): AddContextBundle {
  const loaded = new Set<string>()
  let seededCwdAbs: string | undefined

  return {
    markLoaded: (prefix) => { loaded.add(prefix) },
    markSeededCwd: (absPath) => { seededCwdAbs = absKey(absPath); loaded.add('') },
    loadedPrefixes: () => loaded,
    seededCwd: () => seededCwdAbs,
    handlers: {
      async addContext(source: string) {
        const trimmed = source.trim()
        const isLocal =
          trimmed !== '' &&
          !/^(https:\/\/|git@)/.test(trimmed) &&
          !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        const candidate = isLocal
          ? absKey(isAbsolute(trimmed) ? trimmed : resolve(opts.cwd, trimmed))
          : undefined
        const cwdAbs = absKey(opts.cwd)

        // ── Pre-flight: non-list context cannot be appended to.
        const current = getContext?.()
        if (current !== undefined && !Array.isArray(current)) {
          throw new Error(LIST_CONTEXT_REQUIRED(pythonKindOf(current)))
        }

        // ── Cwd seed short-circuit / recovery
        if (candidate !== undefined && candidate === cwdAbs) {
          if (seededCwdAbs !== undefined) return alreadyLoadedResult('cwd', '')
          const recovered = await resolveSource(source, {
            cwd: opts.cwd,
            pathPrefix: '',
            signal: opts.signal,
          })
          if (!recovered.ok) throw new Error((recovered as { readonly error: string }).error)
          if (recovered.value.payload.length === 0) throw new Error(NO_FILES_PRODUCED)
          if (onLoaded) await onLoaded(recovered.value.payload)
          seededCwdAbs = cwdAbs
          loaded.add('')
          return {
            payload: recovered.value.payload,
            files: recovered.value.files,
            chars: recovered.value.chars,
            sourceId: recovered.value.sourceId,
            pathPrefix: '',
            alreadyLoaded: false,
            documents: 0,
            converted: 0,
            skipped: recovered.value.skipped,
          }
        }

        // ── Subpath of the seeded cwd — short-circuit when context already holds them
        if (
          candidate !== undefined &&
          seededCwdAbs !== undefined &&
          candidate !== seededCwdAbs &&
          (candidate.startsWith(seededCwdAbs + sep) || candidate.startsWith(seededCwdAbs + '/'))
        ) {
          const rel = relative(seededCwdAbs, candidate).split(sep).join('/')
          if (rel !== '' && !rel.startsWith('..') && contextHasUnprefixedUnder(current, rel)) {
            return alreadyLoadedResult('cwd', '')
          }
        }

        // ── Namespace idempotency
        const sourceId = contextSourceId(trimmed, candidate ?? trimmed)
        const pathPrefix = pathPrefixFor(sourceId)
        if (loaded.has(pathPrefix)) return alreadyLoadedResult(sourceId, pathPrefix)

        const resolved = await resolveSource(source, { cwd: opts.cwd, signal: opts.signal })
        if (!resolved.ok) throw new Error((resolved as { readonly error: string }).error)
        if (resolved.value.payload.length === 0) throw new Error(NO_FILES_PRODUCED)

        // Race: another concurrent load of the same prefix finished while we packed.
        if (loaded.has(resolved.value.pathPrefix)) {
          return alreadyLoadedResult(resolved.value.sourceId, resolved.value.pathPrefix)
        }

        if (onLoaded) await onLoaded(resolved.value.payload)
        loaded.add(resolved.value.pathPrefix)
        return {
          payload: resolved.value.payload,
          files: resolved.value.files,
          chars: resolved.value.chars,
          sourceId: resolved.value.sourceId,
          pathPrefix: resolved.value.pathPrefix,
          alreadyLoaded: false,
          documents: 0,
          converted: 0,
          skipped: resolved.value.skipped,
        }
      },
    },
  }
}