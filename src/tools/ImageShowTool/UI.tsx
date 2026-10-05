import type React from 'react'
import { Text } from '../../ink.js'
import { InlineImage } from '../../components/InlineImage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import type { ImageShowOutput } from './ImageShowTool.js'

// ── Tool rendering functions ──
//
// All pixel work is delegated to InlineImage, which picks the best mechanism
// the terminal supports: a real graphics protocol (Kitty / iTerm2 / Sixel)
// painted over a block-glyph render, or the block glyphs alone. It also owns
// sizing, the resize/re-measure reconciliation, and the erase bookkeeping that
// keeps images from ghosting on repaint — none of which belongs in a tool's
// result renderer.

export function renderToolUseMessage(): React.ReactNode {
  return 'Image'
}

export function renderToolResultMessage(
  output: ImageShowOutput,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const { src, success, base64, bytes, error } = output

  if (!success || !base64) {
    return (
      <MessageResponse height={1}>
        <Text color="error">
          Failed to display: {src}
          {error ? ` (${error})` : ''}
        </Text>
      </MessageResponse>
    )
  }

  // InlineImage renders the summary alone until — and unless — it can decode a
  // preview, so a terminal without enough color depth or a build without the
  // image processor still shows a single informative line rather than nothing.
  const size =
    bytes !== undefined
      ? ` (${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)}KB)`
      : ''
  return (
    <MessageResponse>
      <InlineImage base64={base64}>
        <Text>Displayed image: {src}{size}</Text>
      </InlineImage>
    </MessageResponse>
  )
}

export function getToolUseSummary(input: { src?: string } | undefined): string | null {
  if (!input?.src) return null
  return input.src.length > 80 ? input.src.slice(0, 77) + '...' : input.src
}
