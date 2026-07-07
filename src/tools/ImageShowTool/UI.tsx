import React, { useMemo } from 'react'
import Image, { InkPictureProvider } from '../../ink-picture/index.js'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import type { ImageShowOutput } from './ImageShowTool.js'
import { detectTerminalCaps } from './detectTerminal.js'

// ── Image display component ──
// Renders a placeholder in Ink's TUI and uses Kitty/Sixel protocol to draw
// the full-resolution image directly on the terminal framebuffer (bypassing
// the Ink render cycle). The placeholder reserves character cells so the TUI
// layout isn't broken; ink-picture's useDirectRenderer repositions the image
// after each Ink screen refresh.
//
// Terminal detection uses environment variables (TERM, TERM_PROGRAM, etc.)
// instead of ANSI escape queries, avoiding stdin conflicts with Ink's TUI.

export function ImageDisplay({ src, width, height, pixelWidth, pixelHeight }: {
  src: string
  width: number
  height: number
  pixelWidth: number
  pixelHeight: number
}) {
  const terminalInfo = useMemo(() => detectTerminalCaps(), [])

  return (
    <Box flexDirection="column">
      <InkPictureProvider terminalInfo={terminalInfo}>
        <Image
          src={src}
          width={width}
          height={height}
          pixelWidth={pixelWidth}
          pixelHeight={pixelHeight}
          alt={typeof src === 'string' ? src : 'image'}
        />
      </InkPictureProvider>
    </Box>
  )
}

// ── Tool rendering functions ──

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
  output: ImageShowOutput,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const { src, success, width, height, pixelWidth, pixelHeight } = output

  if (!success) {
    return (
      <MessageResponse height={1}>
        <Text color="red">Failed to display: {src}</Text>
      </MessageResponse>
    )
  }

  // Render the image via ink-picture when we have dimension data
  if (width && height && pixelWidth && pixelHeight) {
    return (
      <ImageDisplay
        src={src}
        width={width}
        height={height}
        pixelWidth={pixelWidth}
        pixelHeight={pixelHeight}
      />
    )
  }

  // Fallback: text-only summary
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
