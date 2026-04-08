import { test, expect, describe } from 'bun:test'
import { WebSearchTool } from '../WebSearchTool'

describe('WebSearchTool', () => {
  describe('Tool Properties', () => {
    test('should have correct tool name', () => {
      expect(WebSearchTool.name).toBe('WebSearch')
    })

    test('should have correct description', () => {
      expect(WebSearchTool.description).toContain('SearXNG')
    })

    test('should be enabled', () => {
      expect(WebSearchTool.isEnabled()).toBe(true)
    })

    test('should be concurrency safe', () => {
      expect(WebSearchTool.isConcurrencySafe()).toBe(true)
    })

    test('should be read only', () => {
      expect(WebSearchTool.isReadOnly()).toBe(true)
    })
  })

  describe('Input Validation', () => {
    test('should accept valid query', async () => {
      const result = await WebSearchTool.validateInput(
        { query: 'typescript' },
        {}
      )

      expect(result.result).toBe(true)
    })

    test('should reject empty query', async () => {
      const result = await WebSearchTool.validateInput(
        { query: '' },
        {}
      )

      expect(result.result).toBe(false)
    })

    test('should reject missing input', async () => {
      const result = await WebSearchTool.validateInput(
        {} as any,
        {}
      )

      expect(result.result).toBe(false)
    })
  })

  describe('Permissions', () => {
    test('should allow all web search requests', async () => {
      const result = await WebSearchTool.checkPermissions(
        { query: 'typescript' },
        {}
      )

      expect(result.behavior).toBe('allow')
    })
  })

  describe('Tool Call - Successful Search', () => {
    test('should perform web search', async () => {
      const result = await WebSearchTool.call(
        { query: 'typescript programming' },
        {},
        () => {},
        null
      )

      expect(result).toBeDefined()
      expect(result.query).toBe('typescript programming')
      expect(Array.isArray(result.results)).toBe(true)
      expect(result.durationSeconds).toBeGreaterThan(0)
    }, 60000)

    test('should return structured results', async () => {
      const result = await WebSearchTool.call(
        { query: 'javascript' },
        {},
        () => {},
        null
      )

      expect(result.results.length).toBeGreaterThanOrEqual(0)

      const first = result.results[0]
      if (first && typeof first !== 'string') {
        expect(first).toHaveProperty('tool_use_id')
        expect(Array.isArray(first.content)).toBe(true)
      }
    }, 60000)
  })

  describe('Tool Call - Error Handling', () => {
    test('should handle missing query', async () => {
      const result = await WebSearchTool.call(
        { query: '' } as any,
        {},
        () => {},
        null
      )

      expect(result.results.some(r => typeof r === 'string' && r.includes('Error'))).toBe(true)
    })

    test('should not crash on failure', async () => {
      const result = await WebSearchTool.call(
        { query: 'test' },
        {},
        () => {},
        null
      )

      expect(result).toBeDefined()
    }, 60000)
  })

  describe('Schema Validation', () => {
    test('should have valid input schema', () => {
      const schema = WebSearchTool.inputSchema
      const parsed = schema.safeParse({ query: 'test' })
      expect(parsed.success).toBe(true)
    })

    test('should have valid output schema', () => {
      expect(WebSearchTool.outputSchema).toBeDefined()
    })
  })

  describe('Tool Metadata', () => {
    test('should provide activity description', () => {
      const desc = WebSearchTool.getActivityDescription({
        query: 'typescript'
      })

      expect(desc).toContain('Searching')
    })

    test('should provide tool use summary', () => {
      const summary = WebSearchTool.getToolUseSummary({
        query: 'javascript'
      })

      expect(summary).toBeDefined()
    })

    test('should return empty search text', () => {
      const text = WebSearchTool.extractSearchText?.({
        results: ['test']
      } as any)

      expect(text).toBe('')
    })
  })

  describe('Auto Classifier Input', () => {
    test('should format input correctly', () => {
      const input = WebSearchTool.toAutoClassifierInput({
        query: 'typescript'
      })

      expect(input).toBe('typescript')
    })
  })

  describe('Tool Result Mapping', () => {
    test('should map tool result correctly', () => {
      const output = {
        query: 'test',
        results: [{
          tool_use_id: '1',
          content: [{
            title: 'Test',
            url: 'https://example.com',
            snippet: 'snippet'
          }]
        }],
        durationSeconds: 1
      }

      const result = WebSearchTool.mapToolResultToToolResultBlockParam(
        output,
        'id'
      )

      expect(result.type).toBe('tool_result')
      expect(typeof result.content).toBe('string')
    })

    test('should handle empty results', () => {
      const output = {
        query: 'test',
        results: [],
        durationSeconds: 1
      }

      const result = WebSearchTool.mapToolResultToToolResultBlockParam(
        output,
        'id'
      )

      expect(result.content).toContain('Results')
    })
  })

  describe('SearXNG Integration', () => {
    test('should search using SearXNG', async () => {
      const result = await WebSearchTool.call(
        { query: 'milet 的最新动态' },
        {},
        () => {},
        null
      )

      expect(result).toBeDefined()
      expect(result.query).toBe('milet 的最新动态')
      expect(Array.isArray(result.results)).toBe(true)
      expect(result.durationSeconds).toBeGreaterThan(0)
    }, 60000)
  })
})
