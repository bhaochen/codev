import { describe, expect, test } from 'bun:test'
import { getUndrawnMermaidReasons } from './mermaidDiagramFeedback.js'

const FENCE = '```'
const human = () => ({ type: 'user', message: { content: 'explain this' } })
const toolResult = { type: 'user', toolUseResult: {}, message: { content: [] } }
const meta = { type: 'user', isMeta: true, message: { content: 'reminder' } }
const feedback = {
  type: 'attachment',
  attachment: { type: 'mermaid_not_drawn' },
}
const reply = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const block = (source: string) =>
  `Diagram:\n\n${FENCE}mermaid\n${source}\n${FENCE}\n`
const wide =
  'flowchart LR\n' +
  Array.from(
    { length: 8 },
    (_, i) => `  N${i}[Step number ${i} of it] --> N${i + 1}[Step number ${i + 1} of it]`,
  ).join('\n')

describe('getUndrawnMermaidReasons', () => {
  test('reports only diagrams that do not fit the terminal', () => {
    expect(
      getUndrawnMermaidReasons(
        [human(), reply(block('flowchart TD\n  A --> B'))],
        120,
      ),
    ).toEqual([])
    expect(
      getUndrawnMermaidReasons([human(), reply(block(wide))], 20),
    ).toHaveLength(1)
  })

  test('scans the current turn across tool and meta messages', () => {
    const history = [
      human(),
      reply(block('pie\n  "a" : 1')),
      toolResult,
      meta,
      reply('Done.'),
    ]
    expect(getUndrawnMermaidReasons(history, 120)).toEqual([
      'pie diagrams are not supported',
    ])
  })

  test('does not repeat feedback or inspect older turns', () => {
    expect(
      getUndrawnMermaidReasons(
        [human(), reply(block('pie\n  "a" : 1')), feedback],
        120,
      ),
    ).toEqual([])
    expect(
      getUndrawnMermaidReasons(
        [human(), reply(block('pie\n  "a" : 1')), human()],
        120,
      ),
    ).toEqual([])
  })

  test('ignores prose and nested Mermaid fences', () => {
    expect(
      getUndrawnMermaidReasons(
        [human(), reply('I can draw Mermaid diagrams.')],
        40,
      ),
    ).toEqual([])
    expect(
      getUndrawnMermaidReasons(
        [human(), reply(`- item\n\n  ${FENCE}mermaid\npie\n  "a" : 1\n  ${FENCE}`)],
        40,
      ),
    ).toEqual([])
  })
})
