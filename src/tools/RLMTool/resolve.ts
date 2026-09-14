/**
 * Source resolution: a source string → sandbox-ready {path, content} payload.
 *
 * Simpler than rlm.pi/pi-plugin/rlm/src/context/resolve.ts: local paths only — git URLs and
 * anydoc document conversion (PDF/DOCX) are out of scope for this port. Directory → recursive
 * walk with the same skip rules (node_modules/dist/…, dot-dirs, sensitive files); single
 * file → read with the same byte cap and sensitive-path refusals.
 */

import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Result } from './result.js'
import { err, ok } from './result.js'

export interface ContextFile {
  readonly path: string
  readonly content: string
}

export interface SourceResult {
  readonly payload: readonly ContextFile[]
  readonly files: number
  /** Sum of raw content lengths. */
  readonly chars: number
  readonly sourceId: string
  readonly pathPrefix: string
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
}

export interface ResolveOpts {
  readonly cwd: string
  readonly signal?: AbortSignal
  /** Namespace under which files land (`""` = primary/cwd source, un-prefixed). */
  readonly pathPrefix?: string
}

/** Single-file sources above this must use open() + llm_query_chunked in the REPL. */
export const MAX_CONTEXT_FILE_BYTES = 8 * 1024 * 1024
/** Per-file text size cap when walking a directory. */
export const MAX_WALK_FILE_BYTES = 1_048_576
/** Cap on model-facing skipped entries so an asset-heavy repo cannot flood the wire. */
export const MAX_SKIPPED_REPORTED = 64

/** Non-dot dirs skipped during the walk (codev fallback for repos without .gitignore). */
const FALLBACK_IGNORED: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
])

/** Dot-directories still walked (.github/workflows is often the analysis target). */
const DOT_DIR_ALLOWED: ReadonlySet<string> = new Set(['.github'])

/** Secrets that must never enter context (beneath any .gitignore). */
const SENSITIVE: RegExp =
  /(^|[\/\\])(\.env.*?|\.pypirc|\.netrc|^netrc$|\.git-credentials|id_[rsa].*?|.*?\.pem$)([\/\\]|$)/i

export function isSensitivePath(p: string): boolean {
  return SENSITIVE.test(p)
}

/** Deterministic source id — one identity per (source, absolute path). */
export function contextSourceId(source: string, absPath: string): string {
  const hash = createHash('sha1').update(`${source}\0${absPath}`).digest('hex').slice(0, 10)
  return `ctx-${hash}`
}

export function pathPrefixFor(sourceId: string): string {
  return `ctx/${sourceId}/`
}

/** Normalize a single-file/deep path into a context payload entry. */
function fileEntry(path: string, content: string): ContextFile {
  return { path, content }
}

/** Stack-based recursive walk with the shared skip rules. */
async function walkDirectory(
  rootAbs: string,
  pathPrefix: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ files: ContextFile[]; skipped: { path: string; reason: string }[] }> {
  const files: ContextFile[] = []
  const skipped: { path: string; reason: string }[] = []
  const pending: string[] = [rootAbs]

  while (pending.length > 0) {
    if (signal?.aborted) throw new Error('add_context aborted')
    const dirAbs = pending.pop()!
    let entries
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      continue // unreadable dir — drop silently
    }
    for (const ent of entries) {
      const name = ent.name
      const abs = join(dirAbs, name)
      const rel = abs === rootAbs ? name : abs.slice(rootAbs.length + 1).split(sep).join('/')
      const prefixed = pathPrefix === '' ? rel : `${pathPrefix}${rel}`
      if (ent.isDirectory()) {
        if (FALLBACK_IGNORED.has(name)) continue
        if (name.startsWith('.') && !DOT_DIR_ALLOWED.has(name)) continue
        pending.push(abs)
        continue
      }
      if (isSensitivePath(rel) || isSensitivePath(name)) {
        skipped.push({ path: prefixed, reason: 'sensitive' })
        continue
      }
      let s
      try {
        s = await stat(abs)
      } catch {
        skipped.push({ path: prefixed, reason: 'unreadable' })
        continue
      }
      if (!s.isFile()) continue
      if (s.size > MAX_WALK_FILE_BYTES) {
        skipped.push({ path: prefixed, reason: 'oversize' })
        continue
      }
      let content: string
      try {
        content = await readFile(abs, 'utf8')
      } catch {
        skipped.push({ path: prefixed, reason: 'unreadable' })
        continue
      }
      // Binary guard: refuse raw bytes that would garble the prompt (NUL check).
      if (content.includes('\u0000')) {
        skipped.push({ path: prefixed, reason: 'binary' })
        continue
      }
      files.push(fileEntry(prefixed, content))
    }
  }
  if (skipped.length > MAX_SKIPPED_REPORTED) skipped.length = MAX_SKIPPED_REPORTED
  return { files, skipped }
}

function finish(
  files: ContextFile[],
  skipped: { path: string; reason: string }[],
  sourceId: string,
  pathPrefix: string,
): SourceResult {
  return Object.freeze({
    payload: Object.freeze(files),
    files: files.length,
    chars: files.reduce((sum, f) => sum + f.content.length, 0),
    sourceId,
    pathPrefix,
    skipped: Object.freeze(skipped),
  })
}

/**
 * Resolve a source (local path) into a sandbox-ready SourceResult. `pathPrefix: ""` marks
 * the primary/cwd source so seed paths stay real edit/write-friendly.
 */
export async function resolveSource(
  source: string,
  opts: ResolveOpts,
): Promise<Result<SourceResult, string>> {
  const trimmed = source.trim()
  if (trimmed === '') return err('add_context: empty source')
  if (/^https?:\/\//i.test(trimmed) || /^git@/.test(trimmed)) {
    return err('add_context: git/scheme URLs are not supported — pass a local path')
  }
  const path = isAbsolute(trimmed) ? trimmed : resolve(opts.cwd, trimmed)
  let s
  try {
    s = await stat(path)
  } catch {
    return err(`add_context: path not found: ${path}`)
  }
  const sourceId = contextSourceId(trimmed, path)
  const pathPrefix = opts.pathPrefix !== undefined ? opts.pathPrefix : pathPrefixFor(sourceId)

  if (s.isDirectory()) {
    const walked = await walkDirectory(path, pathPrefix, opts.cwd, opts.signal)
    return ok(finish(walked.files, walked.skipped, sourceId, pathPrefix))
  }

  // Single-file secret refuse — never pack a .env/key into context for a sub-LLM.
  if (isSensitivePath(trimmed.replace(/^\.\//, '')) || isSensitivePath(path)) {
    return err(`add_context: refused sensitive path: ${path}`)
  }
  if (s.size > MAX_CONTEXT_FILE_BYTES) {
    return err(
      `add_context: ${path} is ${s.size.toLocaleString()} bytes ` +
        `(limit ${MAX_CONTEXT_FILE_BYTES.toLocaleString()}) — ` +
        'open() it in the REPL and delegate with llm_query_chunked instead',
    )
  }
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (readErr) {
    return err(`add_context: could not read ${path} (${String(readErr)})`)
  }
  if (content.includes('\u0000')) return err(`add_context: binary file refused: ${path}`)
  const single = fileEntry(`${pathPrefix}${basename(path)}`, content)
  return ok(finish([single], [], sourceId, pathPrefix))
}