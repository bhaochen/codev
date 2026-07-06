import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'

export function renderToolUseMessage(
  { src }: { src?: string },
  { verbose }: { theme?: string; verbose: boolean },
): React.ReactNode {
  if (!src) return null
  if (verbose) return `src: "${src}"`
  return src
}

export function renderToolUseProgressMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor>Rendering image…</Text>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  { src, success }: { src: string; success: boolean },
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!success) {
    return (
      <MessageResponse height={1}>
        <Text color="red">Failed to display: {src}</Text>
      </MessageResponse>
    )
  }
  if (verbose) {
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            Image displayed: <Text bold>{src}</Text>
          </Text>
        </MessageResponse>
      </Box>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text>
        Image displayed: <Text bold>{src}</Text>
      </Text>
    </MessageResponse>
  )
}

export function getToolUseSummary(input: { src?: string } | undefined): string | null {
  if (!input?.src) return null
  return input.src.length > 80 ? input.src.slice(0, 77) + '...' : input.src
}