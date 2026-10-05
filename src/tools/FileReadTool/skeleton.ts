/**
 * Skeleton reads: a file's structure with long function bodies elided.
 *
 * The model sees imports, every signature, class shapes, and comments — the
 * whole 2,000-line file at a glance — with each elided body replaced by a
 * marker carrying the exact offset/limit Read call that recovers it. Line
 * numbers are the file's REAL line numbers (kept runs are numbered with the
 * same formatter as normal reads), so follow-up ranged reads and edits
 * anchor correctly.
 *
 * Symbol boundaries come from the bundled tree-sitter WASM grammars
 * (utils/treesitter/parser.ts): cross-platform, no native binary, no
 * language server to boot. Everything degrades gracefully — unsupported
 * language, parse failure, or a file with nothing worth eliding returns
 * null and the caller falls back to a normal read.
 *
 * Eliding bodies cuts LINES, not BYTES. A file whose bulk sits on one line —
 * an inline sourcemap, a minified bundle, an embedded data URI — survives
 * elision intact and still blows the token cap, so kept lines past
 * MAX_KEPT_LINE_CHARS are truncated with a marker stating how much was
 * dropped. That is the only place skeleton output loses characters rather
 * than whole lines.
 *
 * Safety: skeleton output is a PARTIAL view. The caller must record it with
 * isPartialView: true in readFileState so Edit/Write demand a real Read
 * before mutating the file.
 */

import {
  isSupportedLanguage,
  parse,
  type SyntaxNode,
} from '../../utils/treesitter/parser.js'

/** Formats a contiguous run of kept lines with real line numbers. Injected
 * by the caller (FileReadTool passes addLineNumbers) so this module stays a
 * leaf: no utils/file.js import chain, directly unit-testable. */
export type FormatRun = (content: string, startLine: number) => string

/** A body must span at least this many elidable lines to be worth a marker. */
const MIN_ELIDED_LINES = 6

/** Kept lines longer than this are truncated. Eliding bodies shrinks the LINE
 * count; it does nothing about a single line holding an inline sourcemap, a
 * minified bundle, or an embedded data URI, any of which can exceed the whole
 * token budget on its own. Real source lines effectively never reach 500 chars
 * (the two longest non-sourcemap lines in this repo's largest tool file are
 * 413 and 406), and the cap mirrors the `--max-columns 500` GrepTool already
 * passes to ripgrep. */
const MAX_KEPT_LINE_CHARS = 500

/** Only truncate when it saves more than the marker costs. Lines between
 * MAX_KEPT_LINE_CHARS and MAX_KEPT_LINE_CHARS + this are left intact, so a
 * merely long line is never mangled for a handful of characters. */
const MIN_LINE_TRUNCATION_GAIN = 200

function isOverlongLine(line: string): boolean {
  return line.length > MAX_KEPT_LINE_CHARS + MIN_LINE_TRUNCATION_GAIN
}

/** Cut at `end` without splitting a UTF-16 surrogate pair — slicing an astral
 * character (emoji, CJK extension) in half would emit a lone surrogate. */
function sliceWholeCodeUnits(line: string, end: number): string {
  const lead = line.charCodeAt(end - 1)
  const splitsPair = lead >= 0xd800 && lead <= 0xdbff
  return line.slice(0, splitsPair ? end - 1 : end)
}

/**
 * Truncate one kept line, or return it unchanged.
 *
 * The marker deliberately does NOT offer a `Read offset=N & limit=1` recovery
 * the way body markers do: a line long enough to be truncated here is often
 * long enough to blow the token cap by itself, so that Read would just fail.
 * It reports the fact and lets the caller pick a tool (rg, sed) that can.
 */
function truncateKeptLine(line: string): { text: string; elided: number } {
  if (!isOverlongLine(line)) return { text: line, elided: 0 }
  const head = sliceWholeCodeUnits(line, MAX_KEPT_LINE_CHARS)
  const elided = line.length - head.length
  return { text: `${head} … [+${elided} chars elided from this line]`, elided }
}

/** Per-language structural config: which node types are function-ish bodies,
 * under which parents, and whether the language block-scopes with braces
 * (keep the brace lines) or by indentation (elide the whole block). */
type LanguageShape = {
  grammar: string
  /** body node type → allowed parent node types */
  bodies: Record<string, readonly string[]>
  /** true: elide [start+1, end-1] keeping brace lines; false: elide [start, end] */
  braced: boolean
}

const TS_BODIES: Record<string, readonly string[]> = {
  statement_block: [
    'function_declaration',
    'function_expression',
    'generator_function_declaration',
    'generator_function',
    'arrow_function',
    'method_definition',
  ],
  class_static_block: [],
}

const LANGUAGE_SHAPES: Record<string, LanguageShape> = {
  ts: { grammar: 'typescript', bodies: TS_BODIES, braced: true },
  mts: { grammar: 'typescript', bodies: TS_BODIES, braced: true },
  cts: { grammar: 'typescript', bodies: TS_BODIES, braced: true },
  tsx: { grammar: 'tsx', bodies: TS_BODIES, braced: true },
  js: { grammar: 'javascript', bodies: TS_BODIES, braced: true },
  mjs: { grammar: 'javascript', bodies: TS_BODIES, braced: true },
  cjs: { grammar: 'javascript', bodies: TS_BODIES, braced: true },
  jsx: { grammar: 'tsx', bodies: TS_BODIES, braced: true },
  py: {
    grammar: 'python',
    bodies: { block: ['function_definition'] },
    braced: false,
  },
  go: {
    grammar: 'go',
    bodies: {
      block: ['function_declaration', 'method_declaration', 'func_literal'],
    },
    braced: true,
  },
  rs: {
    grammar: 'rust',
    bodies: { block: ['function_item'] },
    braced: true,
  },
  java: {
    grammar: 'java',
    bodies: {
      block: ['method_declaration', 'constructor_declaration', 'static_initializer'],
      constructor_body: ['constructor_declaration'],
    },
    braced: true,
  },
  rb: {
    grammar: 'ruby',
    bodies: { body_statement: ['method', 'singleton_method'] },
    braced: false,
  },
  cs: {
    grammar: 'c_sharp',
    bodies: {
      block: [
        'method_declaration',
        'constructor_declaration',
        'local_function_statement',
        'destructor_declaration',
        'operator_declaration',
      ],
    },
    braced: true,
  },
  cpp: { grammar: 'cpp', bodies: { compound_statement: ['function_definition'] }, braced: true },
  cc: { grammar: 'cpp', bodies: { compound_statement: ['function_definition'] }, braced: true },
  cxx: { grammar: 'cpp', bodies: { compound_statement: ['function_definition'] }, braced: true },
  hpp: { grammar: 'cpp', bodies: { compound_statement: ['function_definition'] }, braced: true },
  h: { grammar: 'cpp', bodies: { compound_statement: ['function_definition'] }, braced: true },
  c: { grammar: 'cpp', bodies: { compound_statement: ['function_definition'] }, braced: true },
  php: {
    grammar: 'php',
    bodies: { compound_statement: ['function_definition', 'method_declaration'] },
    braced: true,
  },
}

/** Whether skeleton mode supports this file extension (sans dot). */
export function isSkeletonSupportedExt(ext: string): boolean {
  const shape = LANGUAGE_SHAPES[ext.toLowerCase()]
  return shape !== undefined && isSupportedLanguage(shape.grammar)
}

// --- Auto-skeleton policy gates -------------------------------------------
//
// A whole-file Read (no offset/limit, no explicit skeleton flag) of a
// skeleton-supported code file larger than the byte floor returns the
// skeleton instead of full content. The decision is made once at tool
// execution time and the result is frozen into the transcript like any
// other tool output, so the policy is prompt-cache safe on every provider
// (same determinism contract as outputDistill.ts). The model keeps
// full-fidelity escapes: skeleton: false forces the full file; offset/limit
// reads a verbatim range.

const AUTO_SKELETON_ENV_KEYS = [
  'CODEV_AUTO_SKELETON',
  'CLAUDE_CODE_AUTO_SKELETON',
] as const

/** Default ON; disable with CODEV_AUTO_SKELETON=0/false/off/no. */
export function isAutoSkeletonEnabled(): boolean {
  for (const key of AUTO_SKELETON_ENV_KEYS) {
    const value = process.env[key]
    if (
      value &&
      ['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())
    ) {
      return false
    }
  }
  return true
}

/** ~16KB ≈ 4K tokens: below this a full read is cheap enough to keep inline;
 * above it the structure view wins (typical 400+ line source file). */
const DEFAULT_AUTO_SKELETON_MIN_BYTES = 16_000

const AUTO_SKELETON_MIN_BYTES_ENV_KEYS = [
  'CODEV_AUTO_SKELETON_MIN_BYTES',
  'CLAUDE_CODE_AUTO_SKELETON_MIN_BYTES',
] as const

/** File-size floor for auto-skeleton; env override wins when a positive int. */
export function getAutoSkeletonMinBytes(): number {
  for (const key of AUTO_SKELETON_MIN_BYTES_ENV_KEYS) {
    const raw = process.env[key]
    if (!raw) continue
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_AUTO_SKELETON_MIN_BYTES
}

const GENERIC_TOKEN_LIMIT_ADVICE =
  'Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.'

/**
 * Advice sentence for a file-read token-limit error.
 *
 * Points the model at skeleton mode ONLY when the overflowing read was not
 * itself a skeleton request and the file is a skeleton-supported code file.
 * The `skeletonRequested` gate is the loop guard, and it must be the REQUESTED
 * flag, not "was a skeleton produced": all three skeleton outcomes overflow
 * back through here and none may re-suggest skeleton —
 *   1. skeleton built but its output still exceeds the cap (thousands of
 *      signatures, or many long lines under the truncation threshold),
 *   2. skeleton produced nothing (no elidable body, no overlong line) and fell
 *      through to a full read that overflowed,
 *   3. skeleton requested on an unsupported ext, same fall-through.
 * In every case the model already tried skeleton, so suggesting it again would
 * reproduce this exact error verbatim — a deterministic infinite loop. Pure
 * function: same inputs, same string, cache-safe.
 */
export function fileReadTokenLimitAdvice(
  ext: string,
  skeletonRequested: boolean,
): string {
  if (!skeletonRequested && isSkeletonSupportedExt(ext)) {
    return (
      'This is a large code file. Retry this Read with skeleton: true to get its structure — ' +
      'imports, signatures, and class shapes with long function bodies elided — in a single read, ' +
      'then Read specific line ranges (offset/limit) for the bodies you need. ' +
      'You can also search for a specific symbol instead of reading the whole file.'
    )
  }
  return GENERIC_TOKEN_LIMIT_ADVICE
}

export type SkeletonResult = {
  /** Fully formatted content: numbered kept lines + elision markers. */
  formatted: string
  /** Lines of the original file that remain visible. */
  keptLines: number
  /** Lines elided across all bodies. */
  elidedLines: number
  /** Number of elided body regions. */
  elidedRegions: number
  /** Kept lines that were too long to inline and got a truncation marker. */
  truncatedLines: number
  /** Characters dropped across all truncated lines. */
  truncatedChars: number
  totalLines: number
  language: string
}

type ElideRange = { start: number; end: number } // 0-based inclusive rows

function collectElidableRanges(
  root: SyntaxNode,
  shape: LanguageShape,
): ElideRange[] {
  const ranges: ElideRange[] = []
  // Iterative DFS with explicit parent tracking (tree-sitter nodes here
  // don't expose .parent through our narrow type).
  const stack: Array<{ node: SyntaxNode; parentType: string | null }> = [
    { node: root, parentType: null },
  ]
  while (stack.length > 0) {
    const { node, parentType } = stack.pop()!
    const allowedParents = shape.bodies[node.type]
    if (
      allowedParents !== undefined &&
      (allowedParents.length === 0 ||
        (parentType !== null && allowedParents.includes(parentType)))
    ) {
      const startRow = node.startPosition.row
      const endRow = node.endPosition.row
      const range: ElideRange | null = shape.braced
        ? endRow - 1 >= startRow + 1
          ? { start: startRow + 1, end: endRow - 1 }
          : null
        : { start: startRow, end: endRow }
      if (range !== null && range.end - range.start + 1 >= MIN_ELIDED_LINES) {
        ranges.push(range)
      }
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i)
      if (child) stack.push({ node: child, parentType: node.type })
    }
  }
  return ranges
}

/**
 * Build the skeleton for `content`. Returns null when the language is
 * unsupported, parsing is unavailable/failed, or the file has neither a body
 * worth eliding nor an overlong kept line worth truncating (callers fall back
 * to a normal full read).
 */
export async function buildSkeleton(
  content: string,
  ext: string,
  formatRun: FormatRun,
): Promise<SkeletonResult | null> {
  const shape = LANGUAGE_SHAPES[ext.toLowerCase()]
  if (!shape) return null

  const tree = await parse(shape.grammar, content)
  if (!tree) return null

  try {
    const ranges = collectElidableRanges(tree.rootNode, shape)

    const lines = content.split(/\r?\n/)
    const elide = new Array<boolean>(lines.length).fill(false)
    for (const range of ranges) {
      for (let row = range.start; row <= Math.min(range.end, lines.length - 1); row++) {
        elide[row] = true
      }
    }

    // A file with no elidable body is still worth skeletonizing when a KEPT
    // line is long enough to blow the token budget by itself (minified source,
    // inline sourcemap). Lines inside an elided body are already gone, so they
    // never justify a skeleton on their own.
    const hasOverlongKeptLine = lines.some(
      (line, row) => !elide[row] && isOverlongLine(line),
    )
    if (ranges.length === 0 && !hasOverlongKeptLine) return null

    // Emit kept runs through the standard line-number formatter (byte-for-
    // byte the same prefix style as a normal Read) with markers between.
    const out: string[] = []
    let elidedLines = 0
    let elidedRegions = 0
    let truncatedLines = 0
    let truncatedChars = 0
    let row = 0
    while (row < lines.length) {
      if (!elide[row]) {
        const runStart = row
        while (row < lines.length && !elide[row]) row++
        const runLines = lines.slice(runStart, row).map(line => {
          const { text, elided } = truncateKeptLine(line)
          if (elided > 0) {
            truncatedLines++
            truncatedChars += elided
          }
          return text
        })
        out.push(formatRun(runLines.join('\n'), runStart + 1))
      } else {
        const runStart = row
        while (row < lines.length && elide[row]) row++
        const count = row - runStart
        elidedLines += count
        elidedRegions++
        out.push(
          `     ⋮ [body elided: lines ${runStart + 1}-${row} (${count} lines) — Read with offset=${runStart + 1} & limit=${count} to expand]`,
        )
      }
    }

    return {
      formatted: out.join('\n'),
      keptLines: lines.length - elidedLines,
      elidedLines,
      elidedRegions,
      truncatedLines,
      truncatedChars,
      totalLines: lines.length,
      language: shape.grammar,
    }
  } finally {
    tree.delete()
  }
}
