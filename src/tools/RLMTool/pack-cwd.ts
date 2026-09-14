/**
 * CWD context seeding — pack the working directory into the sandbox `context` payload.
 *
 * Simplified version of pi's resolveSource (no BM25 index, no document conversion):
 * a recursive walk skipping noise directories, size/binary caps, producing
 * [{path, content, tokens}].
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Directories never packed into context. */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  '.venv',
  'venv',
  '.tox',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.rbenv',
  '.bundle',
  'target',
  'coverage',
  'vendor',
])

/** Files larger than this (in bytes) are skipped. */
const MAX_FILE_BYTES = 1_000_000
/** Total packed content cap (chars) — bounds the sandbox load and the model's window. */
const MAX_TOTAL_CHARS = 3_000_000
/** Hard cap on packed file count. */
const MAX_FILES = 4_096

export interface ContextFileEntry {
  readonly path: string
  readonly content: string
  readonly tokens: number
}

/** True when the first chunk looks binary (NUL byte in a text-ish file). */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8_192)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

const EXT_ALWAYS_SKIP = new Set(['.pyc', '.so', '.dll', '.exe', '.dylib', '.bin', '.wasm'])

/**
 * Pack `cwd` recursively. Returns entries sorted by path; `{ path: '', content: '', tokens }`
 * is never produced — the empty list means "no files".
 */
export async function packCwd(cwd: string): Promise<ContextFileEntry[]> {
  const out: ContextFileEntry[] = []

  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Deterministic order — sorted names so the pack is stable across runs.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), childRel)
        continue
      }
      if (!e.isFile()) continue
      const ext = e.name.slice(e.name.lastIndexOf('.'))
      if (EXT_ALWAYS_SKIP.has(ext)) continue
      const abs = join(dir, e.name)
      let size: number
      try {
        size = (await stat(abs)).size
      } catch {
        continue
      }
      if (size > MAX_FILE_BYTES) continue
      let buf: Buffer
      try {
        buf = await readFile(abs)
      } catch {
        continue
      }
      if (looksBinary(buf)) continue
      let content: string
      try {
        content = buf.toString('utf8')
      } catch {
        continue
      }
      content = content.replace(/^\uFEFF/, '') // strip BOM
      if (content.length === 0) continue
      out.push({ path: childRel, content, tokens: Math.max(1, (content.length + 3) >> 2) })
    }
  }

  await walk(cwd, '')
  // Sort by path for stable context ordering.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // Total char cap — drop the largest files first until we fit.
  if (out.reduce((n, f) => n + f.content.length, 0) > MAX_TOTAL_CHARS) {
    out.sort((a, b) => b.content.length - a.content.length)
    let total = 0
    const kept: ContextFileEntry[] = []
    for (const f of out) {
      if (total + f.content.length > MAX_TOTAL_CHARS) break
      kept.push(f)
      total += f.content.length
    }
    kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return kept
  }
  return out
}