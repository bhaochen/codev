import * as React from 'react'
import { Text } from '../../ink.js'

/** tool_use 行内展示：折叠/紧凑视图里显示为一行摘要 */
export function renderToolUseMessage(input: {
  dataset?: string
  model?: string
  maxSteps?: number
}): React.ReactNode {
  const parts = [`deep research · ${input.dataset ?? 'deepsearch-demo'}`]
  if (input.model) parts.push(input.model)
  if (input.maxSteps) parts.push(`max-steps ${input.maxSteps}`)
  return parts.join('  ')
}

/** tool_result 展示：完整 benchmark 报告（指标/表格/折线图/建议） */
export function renderToolResultMessage(output: string): React.ReactNode {
  return <Text>{output}</Text>
}

export function getToolUseSummary(
  input: { dataset?: string; model?: string } | undefined,
): string | null {
  if (!input?.dataset) return null
  return input.model ? `${input.dataset} · ${input.model}` : input.dataset
}
