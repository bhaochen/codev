import React, { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { InkPictureProvider } from '../../ink-picture/InkPictureProvider.js'
import type { ImageShowOutput } from './ImageShowTool.js'
import { detectTerminalCaps } from './detectTerminal.js'
import { DirectImageDisplay } from './DirectImageDisplay.js'

// ── Image display component ──
// Follows the old timg approach (commit f6a6fdc):
// - Writes Kitty protocol directly to the terminal fd (bypassing Ink)
// - Renders empty placeholder in Ink for correct TUI layout
// - The image is drawn on the terminal framebuffer without affecting layout

export function ImageDisplay({ src, width, height, pixelWidth, pixelHeight }: {
  src: string
  width: number
  height: number
  pixelWidth: number
  pixelHeight: number
}) {
  const terminalInfo = useMemo(() => detectTerminalCaps(), [])

  const supportsKittyGraphics = terminalInfo.supportsKittyGraphics === true

  if (!supportsKittyGraphics) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Image: {src}</Text>
      </MessageResponse>
    )
  }

  return (
    <Box flexDirection="column">
      <InkPictureProvider terminalInfo={terminalInfo}>
        <DirectImageDisplay
          src={src}
          width={width}
          height={height}
          pixelWidth={pixelWidth}
          pixelHeight={pixelHeight}
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
