import { describe, test, expect } from 'bun:test'
import { z } from 'zod/v4'
import { guardToolInput } from '../toolCallGuard.js'
import type { Tool } from '../../Tool.js'

function makeTool(name: string, schema: z.ZodTypeAny): Tool {
  return { name, inputSchema: schema } as unknown as Tool
}

// Mirrors AskUserQuestionTool's strict schema shape (header required, options
// min 2, extra keys rejected by z.strictObject).
const aqSchema = z.strictObject({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string(),
        options: z
          .array(z.object({ label: z.string(), description: z.string() }))
          .min(2),
      }),
    )
    .min(1),
})

const validQuestions = [
  {
    question: 'Q',
    header: 'H',
    options: [
      { label: 'a', description: 'd' },
      { label: 'b', description: 'e' },
    ],
  },
]

describe('toolCallGuard', () => {
  test('valid input -> ok, recovery.success', () => {
    const tool = makeTool('OkTool', aqSchema)
    const r = guardToolInput(tool, { questions: validQuestions }, 'ok-1')
    expect(r.status).toBe('ok')
    expect(r.recovery.success).toBe(true)
    expect(r.recovery.disposition).toBe('auto_repair')
    expect(r.repairs).toHaveLength(0)
  })

  test('missing cosmetic header -> repaired with safe default', () => {
    // Must be named AskUserQuestion so the SAFE_FIELD_DEFAULTS rule matches.
    const tool = makeTool('AskUserQuestion', aqSchema)
    const input = {
      questions: [
        {
          question: 'Q',
          options: [
            { label: 'a', description: 'd' },
            { label: 'b', description: 'e' },
          ],
        },
      ],
    }
    const r = guardToolInput(tool, input, 'repair-header-1')
    expect(r.status).toBe('repaired')
    expect(r.repairs).toHaveLength(1)
    expect(r.repairs[0]!.type).toBe('missing_required_default')
    expect(r.repairs[0]!.path).toEqual(['questions', 0, 'header'])
    expect(r.repairs[0]!.action).toBe('auto_fill')
    expect(r.parsedInput?.success).toBe(true)
    const data = r.parsedInput?.data as { questions: { header: string }[] }
    expect(data.questions[0]!.header).toBe('Question')
    expect(r.recovery.success).toBe(true)
    expect(r.recovery.final_arguments).not.toBeNull()
  })

  test('extra top-level key -> repaired by dropping it', () => {
    const tool = makeTool('ExtraTool', aqSchema)
    const input = { title: 'x', questions: validQuestions }
    const r = guardToolInput(tool, input, 'repair-extra-1')
    expect(r.status).toBe('repaired')
    expect(r.repairs.some(x => x.action === 'drop_unknown_key')).toBe(true)
    const data = r.parsedInput?.data as { title?: string }
    expect(data.title).toBeUndefined()
  })

  test('missing semantic field (question) -> retry, not auto-filled', () => {
    const tool = makeTool('RetryQTool', aqSchema)
    const input = {
      questions: [
        {
          header: 'H',
          options: [
            { label: 'a', description: 'd' },
            { label: 'b', description: 'e' },
          ],
        },
      ],
    }
    const r = guardToolInput(tool, input, 'retry-question-1')
    expect(r.status).toBe('retry')
    expect(r.disposition).toBe('retry')
    expect(r.error).toBeDefined()
    expect(r.repairs).toHaveLength(0)
    expect(r.recovery.success).toBe(false)
    expect(r.recovery.final_arguments).toBeNull()
  })

  test('options < 2 -> retry (array-length is not auto-repairable)', () => {
    const tool = makeTool('RetryOTool', aqSchema)
    const input = {
      questions: [{ question: 'Q', header: 'H', options: [{ label: 'a', description: 'd' }] }],
    }
    const r = guardToolInput(tool, input, 'retry-options-1')
    expect(r.status).toBe('retry')
    expect(r.repairs).toHaveLength(0)
  })

  test('retry cap -> fatal after MAX_RETRIES (isolated tool name)', () => {
    const tool = makeTool('CapTool', aqSchema)
    const bad = {
      questions: [
        {
          header: 'H',
          options: [
            { label: 'a', description: 'd' },
            { label: 'b', description: 'e' },
          ],
        },
      ],
    }
    const r1 = guardToolInput(tool, bad, 'cap-1')
    const r2 = guardToolInput(tool, bad, 'cap-2')
    const r3 = guardToolInput(tool, bad, 'cap-3')
    expect(r1.status).toBe('retry')
    expect(r2.status).toBe('retry')
    expect(r3.status).toBe('fatal')
    expect(r3.disposition).toBe('fatal')
  })
})
