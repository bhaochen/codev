/**
 * /benchmark —— 数据集加载。
 *
 * 数据集格式（兼容 OpenSeeker/ABSeeker/XBench）：JSON list of
 * {id, query, gt}（gt 兼容 gold / answer 字段）。
 * 内置一个 deepsearch-demo 供开箱即用；也可以用本地文件路径。
 */
import { readFile } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import type { BenchmarkItem } from './types.js'

/**
 * 内置 demo 数据集：覆盖不同检索难度，用于验证 benchmark 流程本身。
 * 格式：{id, query, gt}（gt 兼容 gold / answer 字段）。
 */
const DEMO: BenchmarkItem[] = [
  // 单跳事实（简单）
  { id: 'single-hop-science',   query: 'Who was the first woman to win the Fields Medal? Give a one-line answer.',                    gt: 'Maryam Mirzakhani' },
  { id: 'single-hop-history',   query: 'In what year did the Berlin Wall fall? One-line answer with year only.',                     gt: '1989' },
  // 双跳推理（中等）
  { id: 'multi-hop-tech',       query: 'The programming language Python was created by the founder of which organization that also hosts PyCon?',  gt: 'Python Software Foundation' },
  { id: 'multi-hop-science',    query: 'CRISPR gene editing was pioneered by a scientist at which university that also discovered the double-helix structure of DNA?', gt: 'UC Berkeley' },
  // 否定/易错（需要诚实作答）
  { id: 'unanswerable',         query: 'What was the exact score of the first-ever chess game played on the Moon? Answer concisely.',   gt: 'no verified record of a chess game played on the Moon' },
]

/** 内置数据集清单 */
export const BUILTIN_DATASETS: Record<string, BenchmarkItem[]> = {
  'deepsearch-demo': DEMO,
}

/**
 * 解析数据集参数：返回内置名或本地 JSON 文件（绝对/相对路径）。找不到抛错。
 */
export async function loadDataset(spec: string): Promise<{ name: string; items: BenchmarkItem[] }> {
  const lower = spec.trim()

  if (BUILTIN_DATASETS[lower]) {
    return { name: lower, items: BUILTIN_DATASETS[lower]! }
  }

  const looksLikeFile = lower.endsWith('.json') || isAbsolute(lower) || lower.includes('/')
  if (looksLikeFile) {
    const p = resolve(process.cwd(), lower)
    try {
      const raw = await readFile(p, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const items = toItems(parsed)
      if (items.length === 0) throw new Error('dataset is empty')
      return { name: p, items }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`cannot load dataset "${lower}": ${msg}`)
    }
  }

  throw new Error(
    `unknown dataset "${lower}". Built-ins: ${Object.keys(BUILTIN_DATASETS).join(', ')}. Or point to a JSON file of {id, query, gt} objects.`,
  )
}

function toItems(parsed: unknown): BenchmarkItem[] {
  if (!Array.isArray(parsed)) throw new Error('dataset must be a JSON array')
  return parsed.flatMap((raw, i) => {
    if (typeof raw !== 'object' || raw === null) return []
    const r = raw as Record<string, unknown>
    const query = typeof r.query === 'string' ? r.query : ''
    const gtRaw = r.gt ?? r.gold ?? r.answer
    const gt = typeof gtRaw === 'string' ? gtRaw : Array.isArray(gtRaw) ? gtRaw.map(String).join(' | ') : ''
    const id = typeof r.id === 'string' ? r.id : `item-${i + 1}`
    if (!query || !gt) return []
    return [{ id, query, gt }]
  })
}
