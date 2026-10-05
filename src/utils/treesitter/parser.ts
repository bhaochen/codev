/**
 * OS-generic tree-sitter parsing service (WASM via web-tree-sitter).
 *
 * Loads the platform-independent WASM runtime + prebuilt grammar blobs that
 * ship as ordinary npm dependencies (`web-tree-sitter` + `@vscode/tree-sitter-wasm`).
 * It therefore works identically on Windows / macOS / Linux with no native
 * build, no toolchain (no Go / node-gyp), and — critically — NO hardcoded
 * filesystem paths: assets are resolved from installed packages or from the
 * adjacent vendor directory populated by the standalone build.
 *
 * Everything here degrades gracefully: any failure (missing dependency, load
 * error, unsupported language, parser crash) resolves to `null`. Callers MUST
 * treat parsing as best-effort and never depend on it succeeding.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Locate assets via Node module resolution rather than absolute paths. Named
// `tsRequire` (not `require`) so it never collides with the bundle's
// banner-injected `require`.
const tsRequire = createRequire(import.meta.url)

function resolveAsset(packagePath: string, filename: string): string {
  try {
    return tsRequire.resolve(packagePath)
  } catch {
    return join(dirname(process.execPath), 'vendor', 'tree-sitter', filename)
  }
}

// Loose external types — we avoid a static dependency on the module's exact
// shape (it loads lazily and may be absent at runtime).
type ParserClass = {
  new (): {
    setLanguage(language: unknown): void
    parse(code: string): SyntaxTree | null
  }
  init(options?: { locateFile?: (file: string) => string }): Promise<void>
}
type LanguageClass = { load(bytes: Uint8Array): Promise<unknown> }
type TreeSitterModule = { Parser: ParserClass; Language: LanguageClass }

export type SyntaxPoint = {
  row: number
  column: number
}

export type SyntaxNode = {
  type: string
  isError: boolean
  isMissing: boolean
  hasError: boolean
  childCount: number
  child(index: number): SyntaxNode | null
  // Position accessors (present on every web-tree-sitter node; typed here so
  // structural consumers like the Read skeleton mode can use them).
  startPosition: SyntaxPoint
  endPosition: SyntaxPoint
  startIndex: number
  endIndex: number
}

export type SyntaxTree = {
  rootNode: SyntaxNode
  delete(): void
}

// Grammar key -> @vscode/tree-sitter-wasm blob basename. Only grammars the
// package actually ships are listed here.
const GRAMMAR_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-tsx',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  ruby: 'tree-sitter-ruby',
  c_sharp: 'tree-sitter-c-sharp',
  cpp: 'tree-sitter-cpp',
  css: 'tree-sitter-css',
  php: 'tree-sitter-php',
}

let modulePromise: Promise<TreeSitterModule | null> | null = null
const languageCache = new Map<string, Promise<unknown | null>>()
let parser: InstanceType<ParserClass> | null = null

function debug(msg: string): void {
  if (process.env.CODEV_DEBUG_TREESITTER === '1') {
    process.stderr.write(`[tree-sitter] ${msg}\n`)
  }
}

/** Lazily import + init the WASM runtime exactly once. */
function loadModule(): Promise<TreeSitterModule | null> {
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        const mod = (await import('web-tree-sitter')) as Record<string, unknown>
        const def = mod.default as Record<string, unknown> | undefined
        const Parser = (mod.Parser ?? def?.Parser) as ParserClass | undefined
        const Language = (mod.Language ?? def?.Language) as
          | LanguageClass
          | undefined
        if (!Parser || !Language || typeof Parser.init !== 'function') {
          debug('web-tree-sitter missing Parser/Language/init exports')
          return null
        }
        // `locateFile` points the emscripten loader at the runtime wasm
        // regardless of cwd or bundle layout — resolved via Node, OS-generic.
        const runtimeWasm = resolveAsset(
          'web-tree-sitter/web-tree-sitter.wasm',
          'web-tree-sitter.wasm',
        )
        await Parser.init({
          locateFile: (file: string) =>
            file.endsWith('.wasm') ? runtimeWasm : file,
        })
        return { Parser, Language }
      } catch (err) {
        debug(`init failed: ${(err as Error)?.message ?? String(err)}`)
        return null
      }
    })()
  }
  return modulePromise
}

/** Lazily load + cache a grammar by key. */
function loadLanguage(
  ts: TreeSitterModule,
  language: string,
): Promise<unknown | null> {
  const cached = languageCache.get(language)
  if (cached) return cached
  const promise = (async () => {
    const base = GRAMMAR_FILES[language]
    if (!base) return null
    try {
      const wasmPath = resolveAsset(
        `@vscode/tree-sitter-wasm/wasm/${base}.wasm`,
        `${base}.wasm`,
      )
      // Load from BYTES (not a path) so nothing depends on cwd at parse time.
      const bytes = new Uint8Array(readFileSync(wasmPath))
      return await ts.Language.load(bytes)
    } catch (err) {
      debug(
        `grammar load failed (${language}): ${(err as Error)?.message ?? String(err)}`,
      )
      return null
    }
  })()
  languageCache.set(language, promise)
  return promise
}

export function isSupportedLanguage(language: string): boolean {
  return language in GRAMMAR_FILES
}

/**
 * Parse `code` as `language`. Returns a tree (the caller MUST call `.delete()`
 * when finished, to free WASM memory) or `null` if parsing is unavailable.
 */
export async function parse(
  language: string,
  code: string,
): Promise<SyntaxTree | null> {
  try {
    const ts = await loadModule()
    if (!ts) return null
    const lang = await loadLanguage(ts, language)
    if (!lang) return null
    // Reuse one parser. `setLanguage` + `parse` run synchronously with no
    // `await` between, so concurrent async callers cannot interleave and parse
    // with the wrong language.
    if (!parser) parser = new ts.Parser()
    parser.setLanguage(lang)
    return parser.parse(code) ?? null
  } catch (err) {
    debug(
      `parse failed (${language}): ${(err as Error)?.message ?? String(err)}`,
    )
    return null
  }
}
