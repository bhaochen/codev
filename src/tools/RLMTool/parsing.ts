/**
 * Parsing helpers: extract ```repl``` code blocks from a model response.
 */

const FENCE = /(`{3,})[ \t]*repl[ \t]*\r?\n([\s\S]*?)\1/g
// The info string is captured so a rejected tag (e.g. ```text) still consumes its whole fence —
// otherwise that fence's own closing ``` could later match as a bare opener and swallow code.
const FALLBACK_FENCE = /(`{3,})[ \t]*([^`\r\n]*)[ \t]*\r?\n([\s\S]*?)\1/g
const PYTHON_TAG = /^py(thon)?$/i

/** Shared fence scan: run `re` over `text`, keep bodies the selector accepts (same trimming). */
function collectFences(
  text: string,
  re: RegExp,
  select: (m: RegExpExecArray) => string | null,
): string[] {
  const blocks: string[] = []
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(text)) !== null) {
    const code = select(m)
    if (code !== null && code.trim()) blocks.push(code.replace(/\s+$/, ''))
  }
  return blocks
}

/**
 * Return every ```repl``` block body, in document order. If the response has none, fall back to
 * ```python / ```py / untagged fences — never other language tags, and never a mix of both kinds.
 */
export function findReplBlocks(text: string): string[] {
  const repl = collectFences(text, FENCE, (m) => m[2] ?? '')
  if (repl.length > 0) return repl
  return collectFences(text, FALLBACK_FENCE, (m) => {
    const tag = m[2] ?? ''
    return tag === '' || PYTHON_TAG.test(tag) ? (m[3] ?? '') : null
  })
}

/** Truncate REPL stdout for the model's context window (head + tail, with an elision note).
 *  `mark` lets callers specialize the wording (root elision cites the session log) while the
 *  head/tail math stays the one implementation. */
export function truncateOutput(text: string, limit = 20_000, mark = 'chars elided'): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  const cut = text.length - head - tail
  return `${text.slice(0, head)}\n... [${cut} ${mark}] ...\n${text.slice(-tail)}`
}
