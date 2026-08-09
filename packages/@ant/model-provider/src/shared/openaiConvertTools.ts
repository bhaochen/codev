/**
 * Anthropic 工具 schema → OpenAI function calling 格式转换。
 *
 * Anthropic:  { name, description, input_schema }
 * OpenAI:     { type: "function", function: { name, description, parameters } }
 *
 * 兼容性要点：
 * - `const` 关键字在很多 OpenAI 兼容端点（Ollama、vLLM、DeepSeek 等）不受支持，
 *   递归清洗为语义等价的 `enum: [value]`。
 * - cache_control / defer_loading 等 Anthropic 专属字段丢弃。
 */
import type { OpenAITool } from '../types.js'

/**
 * 递归清洗 JSON Schema，将 `const` 转为单元素 `enum`。
 * 兼容不支持 `const` 的 OpenAI 兼容端点（Ollama / vLLM / DeepSeek 等）。
 */
function sanitizeJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema

  const result = { ...schema }

  if ('const' in result) {
    result.enum = [result.const]
    delete result.const
  }

  // 递归处理嵌套 schema 对象
  const objectKeys = [
    'properties',
    'definitions',
    '$defs',
    'patternProperties',
  ] as const
  for (const key of objectKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object') {
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(
        nested as Record<string, unknown>,
      )) {
        sanitized[k] =
          v && typeof v === 'object'
            ? sanitizeJsonSchema(v as Record<string, unknown>)
            : v
      }
      result[key] = sanitized
    }
  }

  // 递归处理单 schema 键
  const singleKeys = [
    'items',
    'additionalProperties',
    'not',
    'if',
    'then',
    'else',
    'contains',
    'propertyNames',
  ] as const
  for (const key of singleKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      result[key] = sanitizeJsonSchema(nested as Record<string, unknown>)
    }
  }

  // 递归处理 schema 数组键
  const arrayKeys = ['anyOf', 'oneOf', 'allOf'] as const
  for (const key of arrayKeys) {
    const nested = result[key]
    if (Array.isArray(nested)) {
      result[key] = nested.map(item =>
        item && typeof item === 'object'
          ? sanitizeJsonSchema(item as Record<string, unknown>)
          : item,
      )
    }
  }

  return result
}

export type AnthropicToolSchema = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

/**
 * 转换 Anthropic 工具定义为 OpenAI function calling 格式。
 */
export function convertAnthropicToolsToOpenAI(
  tools: AnthropicToolSchema[],
): OpenAITool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: sanitizeJsonSchema(
        tool.input_schema || { type: 'object', properties: {} },
      ),
    },
  }))
}

/**
 * 映射 Anthropic tool_choice 到 OpenAI tool_choice。
 *
 * Anthropic → OpenAI:
 * - { type: "auto" } → "auto"
 * - { type: "any" }  → "required"
 * - { type: "tool", name } → { type: "function", function: { name } }
 * - undefined → undefined（用 provider 默认）
 */
export function anthropicToolChoiceToOpenAI(
  toolChoice: unknown,
): string | { type: 'function'; function: { name: string } } | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined

  const tc = toolChoice as Record<string, unknown>
  const type = tc.type as string

  switch (type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return {
        type: 'function',
        function: { name: tc.name as string },
      }
    default:
      return undefined
  }
}