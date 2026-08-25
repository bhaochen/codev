import * as React from 'react'
import { Box, Text } from '../../ink.js'

/** tool_use 行内展示：折叠/紧凑视图里显示为一行摘要（无 emoji） */
export function renderToolUseMessage(
  input: { dataset?: string; model?: string; maxSteps?: number } | undefined,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const dataset = input?.dataset ?? 'deepsearch-demo'
  const parts = [`benchmark · ${dataset}`]
  if (verbose) {
    if (input?.model) parts.push(input.model)
    if (input?.maxSteps) parts.push(`max-steps ${input.maxSteps}`)
  }
  return parts.join('  ')
}

/**
 * tool_result 展示：
 *   - verbose（点击展开后）→ 完整 benchmark 报告
 *   - 非 verbose（默认折叠）→ 标题 + 关键指标摘要 + 展开提示
 */
export function renderToolResultMessage(
  output: string,
  _progressMessagesForMessage: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (verbose) {
    return <Text>{output}</Text>
  }
  // 折叠态：只显示标题与指标段（▍per-question 之前），其余折叠
  const summary = output.split(/\n▍per-question/)[0] ?? output
  return (
    <Box flexDirection="column">
      <Text>{summary}</Text>
      <Text dimColor>{'  ▸ click to expand for full report'}</Text>
    </Box>
  )
}

export function getToolUseSummary(
  input: { dataset?: string; model?: string } | undefined,
): string | null {
  if (!input?.dataset) return null
  return input.model ? `${input.dataset} · ${input.model}` : input.dataset
}
