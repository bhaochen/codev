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

const DEMO: BenchmarkItem[] = [
  {
    id: 'demo-1',
    query: 'Who was the first woman to win the Fields Medal? Give a one-line answer.',
    gt: 'Maryam Mirzakhani',
  },
  {
    id: 'demo-2',
    query:
      'Bob Dylan won the 2016 Nobel Prize in Literature. In what year was his album "Highway 61 Revisited" released?',
    gt: '1965',
  },
  {
    id: 'demo-3',
    query:
      'The musical "Hamilton" opened on Broadway in 2015. Which Founding Father is the show’s protagonist?',
    gt: 'Alexander Hamilton',
  },
  {
    id: 'demo-4',
    query:
      'The 2023 film "Oppenheimer" was directed by which filmmaker who also directed "The Dark Knight" trilogy?',
    gt: 'Christopher Nolan',
  },
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