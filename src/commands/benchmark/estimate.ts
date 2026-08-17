/**
 * /benchmark —— token 估算与文本工具。
 *
 * LongSeeker 的 context 统计不需要精确 token 数，用启发式估算即可：
 * CJK 字符 ≈ 0.8 token，其余字符每 4 个 ≈ 1 token。够用于观察增长曲线、
 * 判定何时该压缩/删除。
 */

/** 估算一段文本的 token 数（启发式，用于 context 增长统计） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === undefined) continue
    // CJK 统一表意文字、标点、全角、谚文
    const isCJK =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xac00 && code <= 0xd7af)
    if (isCJK) cjk++
    else ascii++
  }
  return Math.round(cjk * 0.8 + ascii / 4)
}

/** 去掉 HTML 标签与常见实体，得到纯文本 */
export function stripTags(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** 压缩连续空白，用于展示/search snippet 清洗 */
export function normalizeSpace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** 截断长文本（按字符），并在中间省略 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}