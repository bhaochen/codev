import { describe, expect, test } from 'bun:test'
import { stringWidth } from '../ink/stringWidth.js'
import { fitMermaidArt, MERMAID_WIDTH_MARGIN } from './mermaidDiagram.js'

const chart = (
  labels: string,
  values: string,
  title = 'title "Quarterly totals"',
) => `xychart-beta\n  ${title}\n  x-axis [${labels}]\n  bar [${values}]`

describe('responsive xychart rendering', () => {
  test('fits every row within the usable terminal width', () => {
    for (const columns of [28, 40, 80, 120]) {
      const drawing = fitMermaidArt(
        chart('"Jan", "Feb", "Mar"', '10, 25, 18'),
        columns,
      )
      expect('fallback' in drawing).toBe(false)
      if ('fallback' in drawing) continue
      expect(drawing.art.width).toBe(columns - MERMAID_WIDTH_MARGIN)
      for (const row of drawing.art.rows) {
        expect(stringWidth(row.map(span => span.text).join(''))).toBeLessThanOrEqual(
          columns - MERMAID_WIDTH_MARGIN,
        )
      }
    }
  })

  test('truncates wide labels and titles by terminal columns', () => {
    const drawing = fitMermaidArt(
      chart('"漢字の長い名前", "Another very long label"', '9, 12', 'title "漢字の長い見出し"'),
      32,
    )
    expect('fallback' in drawing).toBe(false)
    if ('fallback' in drawing) return
    for (const row of drawing.art.rows) {
      expect(stringWidth(row.map(span => span.text).join(''))).toBeLessThanOrEqual(
        32 - MERMAID_WIDTH_MARGIN,
      )
    }
  })

  test('draws all-zero values without inventing nonzero bars', () => {
    const drawing = fitMermaidArt(chart('A, B', '0, 0', ''), 60)
    expect('fallback' in drawing).toBe(false)
    if ('fallback' in drawing) return
    const rows = drawing.art.rows.slice(0).map(row => row.map(span => span.text).join(''))
    expect(rows.every(row => !row.includes('█'))).toBe(true)
  })

  test('respects an explicit y-axis range', () => {
    const drawing = fitMermaidArt(
      'xychart-beta\n  x-axis [A, B]\n  y-axis 10 --> 20\n  bar [10, 20]',
      60,
    )
    expect('fallback' in drawing).toBe(false)
    if ('fallback' in drawing) return
    const rows = drawing.art.rows.map(row => row.map(span => span.text).join(''))
    expect(rows[0]!.match(/█/g) ?? []).toHaveLength(0)
    expect(rows[1]!.match(/█/g)?.length).toBeGreaterThan(0)
  })

  test('rejects malformed, mismatched, negative, or excessive series', () => {
    const malformed = [
      chart('A, B', '1,,2', ''),
      chart('A, B', '1', ''),
      chart('A, B', '-1, 2', ''),
      chart(
        Array.from({ length: 21 }, (_, index) => `L${index}`).join(', '),
        Array.from({ length: 21 }, () => '1').join(', '),
        '',
      ),
    ]
    for (const source of malformed) {
      const drawing = fitMermaidArt(source, 120)
      expect('fallback' in drawing).toBe(true)
    }
    expect(
      'fallback' in
        fitMermaidArt(
          'xychart-beta\n  x-axis [A]\n  bar [1]\n  line [2]',
          120,
        ),
    ).toBe(true)
    const tooMany = fitMermaidArt(malformed[3]!, 120)
    expect('fallback' in tooMany && tooMany.fallback.kind).toBe('too-large')
  })

  test('does not try to draw a chart narrower than its minimum layout', () => {
    const drawing = fitMermaidArt(chart('A, B', '1, 2', ''), 12)
    expect('fallback' in drawing && drawing.fallback.kind).toBe('too-wide')
  })

  test('removes terminal control characters from generated labels', () => {
    const drawing = fitMermaidArt(chart('"Safe\u001b[31m label"', '2', ''), 60)
    expect('fallback' in drawing).toBe(false)
    if ('fallback' in drawing) return
    const rendered = drawing.art.rows
      .flatMap(row => row.map(span => span.text))
      .join('')
    expect(rendered).not.toContain('\u001b')
    expect(rendered).toContain('Safe')
  })
})
