import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { Ansi, Box, Text } from '../../ink.js'

const MAX_RESULT_CHARS = 20000

function formatResult(result: ToolResultBlockParam['content']): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .map(block => ('text' in block && typeof block.text === 'string' ? block.text : JSON.stringify(block)))
      .join('\n')
  }
  return JSON.stringify(result)
}

export function RawToolResultMessage({
  result,
}: {
  result: ToolResultBlockParam['content']
}): React.ReactNode {
  const formatted = formatResult(result)
  const text =
    formatted.length > MAX_RESULT_CHARS
      ? `${formatted.slice(0, MAX_RESULT_CHARS)}\n… (output truncated)`
      : formatted

  return (
    <Box marginLeft={5}>
      <Text>
        <Ansi>{text}</Ansi>
      </Text>
    </Box>
  )
}
