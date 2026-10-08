import { describe, test, expect } from 'bun:test'
import { z } from 'zod/v4'
import { guardToolInput } from '../toolCallGuard.js'
import type { Tool } from '../../../Tool.js'

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

  describe('placeholder arguments', () => {
    const phSchema = z.strictObject({
      path: z.string().min(1),
      limit: z.number().min(1).optional(),
      id: z.string().min(1).optional(),
      verbose: z.boolean().optional(),
    })

    test('0 on a min-1 optional number is dropped as a placeholder', () => {
      const tool = makeTool('PhNumber', phSchema)
      const r = guardToolInput(tool, { path: 'a.ts', limit: 0 }, 'ph-num-1')
      expect(r.status).toBe('repaired')
      expect(r.repairs.some(x => x.action === 'drop_placeholder')).toBe(true)
      expect((r.parsedInput?.data as { limit?: number }).limit).toBeUndefined()
    })

    test('multiple placeholders are dropped in one shot', () => {
      const tool = makeTool('PhMulti', phSchema)
      const r = guardToolInput(
        tool,
        { path: 'a.ts', verbose: null, id: '' },
        'ph-multi-1',
      )
      expect(r.status).toBe('repaired')
      const data = r.parsedInput?.data as { verbose?: boolean; id?: string }
      expect(data.verbose).toBeUndefined()
      expect(data.id).toBeUndefined()
    })

    test('a required placeholder is never dropped', () => {
      const tool = makeTool('PhRequired', phSchema)
      const r = guardToolInput(tool, { path: '' }, 'ph-req-1')
      expect(r.status).toBe('retry')
      expect(r.repairs).toHaveLength(0)
    })

    test('array items are never removed', () => {
      const tool = makeTool(
        'PhArray',
        z.strictObject({ tags: z.array(z.string().min(1)).min(1) }),
      )
      const r = guardToolInput(tool, { tags: [''] }, 'ph-arr-1')
      expect(r.status).toBe('retry')
    })
  })

  describe('type coercion', () => {
    test('a numeric string for a number field is coerced', () => {
      const tool = makeTool(
        'CoerceNumber',
        z.strictObject({ count: z.number() }),
      )
      const r = guardToolInput(tool, { count: '7' }, 'coerce-num-1')
      expect(r.status).toBe('repaired')
      expect(r.repairs.some(x => x.action === 'coerce_type')).toBe(true)
      expect((r.parsedInput?.data as { count: number }).count).toBe(7)
    })

    test('a near-miss key spelling is recovered', () => {
      const tool = makeTool(
        'CoerceKey',
        z.strictObject({ file_path: z.string() }),
      )
      const r = guardToolInput(tool, { filePath: 'a.ts' }, 'coerce-key-1')
      expect(r.status).toBe('repaired')
      expect((r.parsedInput?.data as { file_path: string }).file_path).toBe('a.ts')
    })

    test('coercion that cannot make input valid still retries', () => {
      const tool = makeTool(
        'CoerceBad',
        z.strictObject({ count: z.number().min(10) }),
      )
      const r = guardToolInput(tool, { count: '3' }, 'coerce-bad-1')
      expect(r.status).toBe('retry')
    })
  })

  describe('unknown MCP arguments', () => {
    const strictMcp = {
      name: 'mcp__srv__do',
      inputSchema: z.object({}).passthrough(),
      inputJSONSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { query: { type: 'string' } },
      },
    } as unknown as Tool

    test('rejects a param the strict JSON schema does not declare', () => {
      const r = guardToolInput(strictMcp, { query: 'a', bogus: 1 }, 'mcp-unknown-1')
      expect(r.status).toBe('retry')
      expect(r.issuesMessage).toContain('bogus')
    })

    test('accepts declared params only', () => {
      const r = guardToolInput(strictMcp, { query: 'a' }, 'mcp-ok-1')
      expect(r.status).toBe('ok')
    })

    test('a permissive JSON schema still accepts extras', () => {
      const permissive = {
        name: 'mcp__srv__perm',
        inputSchema: z.object({}).passthrough(),
        inputJSONSchema: { type: 'object', properties: { query: {} } },
      } as unknown as Tool
      const r = guardToolInput(permissive, { query: 'a', extra: 1 }, 'mcp-perm-1')
      expect(r.status).toBe('ok')
    })
  })
})
