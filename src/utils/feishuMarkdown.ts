/**
 * Feishu 卡片 Markdown 样式优化（内联实现，不依赖外部文件）
 *
 * 背景:
 * - 飞书卡片的 `tag: 'markdown'` 元素对 H1~H3 标题有已知渲染异常（字面量显示）。
 *   必须降级为 H4/H5 才能正常渲染。
 * - Schema 2.0 CardKit 支持完整的 markdown 但需要手动加 `<br>` 间距避免标题/表格/
 *   代码块贴得太紧。
 * - 卡片有表格数量上限（FEISHU_CARD_TABLE_LIMIT=3），超出会触发 230099/11310。
 * - 图片必须是飞书上传过的 `img_xxx` key，其它 URL 会触发 CardKit 错误 200570。
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 飞书卡片表格数量上限 —— 超出 3 张触发 230099/11310 */
export const FEISHU_CARD_TABLE_LIMIT = 3

// ---------------------------------------------------------------------------
// Public: optimizeMarkdownForFeishu
// ---------------------------------------------------------------------------

/**
 * 对将要放入 `tag: 'markdown'` 元素的 markdown 做安全预处理。
 *
 * - 标题降级: 若原文包含 H1~H3，则 H2~H6 → H5，H1 → H4
 * - 代码块内容受保护，不会被降级
 * - Schema 2.0: 连续标题/表格/代码块前后加 `<br>` 间距
 * - 连续 3+ 空行压缩为 2
 * - 删除非 `img_*` 的 markdown 图片引用（防止 CardKit 200570）
 * - 任何内部错误都 fallback 到原文，不阻塞消息发送
 */
export function optimizeMarkdownForFeishu(text: string, cardVersion = 2): string {
  try {
    let r = _optimizeMarkdownForFeishu(text, cardVersion)
    r = stripInvalidImageKeys(r)
    return r
  } catch {
    return text
  }
}

function _optimizeMarkdownForFeishu(text: string, cardVersion: number): string {
  // ── 1. 提取代码块，用占位符保护，处理后再还原 ─────────────────────
  const MARK = '___CB_'
  const codeBlocks: string[] = []
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`
  })

  // ── 2. 标题降级 ────────────────────────────────────────────────────
  const hasH1toH3 = /^#{1,3} /m.test(text)
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1') // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, '#### $1') // H1 → H4
  }

  // ── 3. Schema 2.0 段落间距 ────────────────────────────────────────
  if (cardVersion >= 2) {
    // 3a. 连续标题之间加 <br>
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2')

    // 3b. 非表格行直接跟表格行 → 先补空行
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2')

    // 3c. 表格前: 在空行之前插入 <br>
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1')

    // 3d. 表格后: 在表格块末尾追加 <br>
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
      const after = r.slice(offset + m.length).replace(/^\n+/, '')
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m
      return m + '\n<br>\n'
    })

    // 3e. 表格前是普通文本: 只保留 <br>，去掉多余空行
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3')

    // 3f. 表格前是加粗行: <br> 紧贴加粗行，空行保留在后面
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3')

    // 3g. 表格后是普通文本: 去掉多余空行
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3')
  }

  // ── 4. 压缩多余空行（3 个以上连续换行 → 2 个）────────────────────
  r = r.replace(/\n{3,}/g, '\n\n')

  // ── 5. 还原代码块 ─────────────────────────────────────────────────
  codeBlocks.forEach((block, i) => {
    const replacement = cardVersion >= 2 ? `\n<br>\n${block}\n<br>\n` : block
    r = r.replace(`${MARK}${i}___`, replacement)
  })

  return r
}

// ---------------------------------------------------------------------------
// stripInvalidImageKeys
// ---------------------------------------------------------------------------

/** 匹配完整的 markdown 图片语法: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

/**
 * 删除 value 不是飞书 image key (`img_xxx`) 的 markdown 图片引用。
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch
    return ''
  })
}

// ---------------------------------------------------------------------------
// Table limiting: sanitizeTextForCard
// ---------------------------------------------------------------------------

export type MarkdownTableMatch = {
  index: number
  length: number
  raw: string
}

/**
 * 扫描正文里会被飞书卡片实际渲染的 markdown 表格位置。
 */
export function findMarkdownTablesOutsideCodeBlocks(text: string): MarkdownTableMatch[] {
  const codeBlockRanges: Array<{ start: number; end: number }> = []
  const codeBlockRegex = /```[\s\S]*?```/g
  let cbMatch = codeBlockRegex.exec(text)
  while (cbMatch != null) {
    codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length })
    cbMatch = codeBlockRegex.exec(text)
  }
  const isInsideCodeBlock = (idx: number): boolean =>
    codeBlockRanges.some((range) => idx >= range.start && idx < range.end)

  const tableRegex = /\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g
  const matches: MarkdownTableMatch[] = []
  let tableMatch = tableRegex.exec(text)
  while (tableMatch != null) {
    if (!isInsideCodeBlock(tableMatch.index)) {
      matches.push({ index: tableMatch.index, length: tableMatch[0].length, raw: tableMatch[0] })
    }
    tableMatch = tableRegex.exec(text)
  }
  return matches
}

/**
 * 对正文里超出 tableLimit 张的 markdown 表格降级为代码块，防止触发 230099/11310。
 */
export function sanitizeTextForCard(
  text: string,
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): string {
  const matches = findMarkdownTablesOutsideCodeBlocks(text)
  if (matches.length <= tableLimit) return text
  let result = text
  for (let i = matches.length - 1; i >= tableLimit; i--) {
    const { index, length, raw } = matches[i]!
    result = result.slice(0, index) + '```\n' + raw + '\n```' + result.slice(index + length)
  }
  return result
}