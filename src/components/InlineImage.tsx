import React from 'react'
import Image, { InkPictureProvider } from 'ink-picture'
import Link from '../ink/components/Link.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { Box, Text } from '../ink.js'

type Props = {
  url: string
  alt?: string
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const parts = pathname.split('/')
    const last = parts[parts.length - 1]
    return last || 'image'
  } catch {
    return 'image'
  }
}

/**
 * Renders an inline image in the terminal using ink-picture, which
 * auto-detects the best available protocol (Kitty, Sixel, iTerm2,
 * HalfBlock, Braille, ASCII) and handles loading/error states.
 *
 * A clickable [image_name] link is shown below the image as a stable
 * fallback for screen readers and quick URL access.
 */
export function InlineImage({ url, alt }: Props) {
  const displayName = alt || filenameFromUrl(url)

  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 40
  const imgWidth = Math.floor(cols * 0.6)
  const imgHeight = Math.floor(rows * 0.4)

  const link = supportsHyperlinks() ? (
    <Link url={url}>
      <Text dimColor>{`[${displayName}]`}</Text>
    </Link>
  ) : (
    <Text dimColor>{`[${displayName}: ${url}]`}</Text>
  )

  return (
    <Box flexDirection="column">
      <InkPictureProvider>
        <Image
          src={url}
          width={imgWidth}
          height={imgHeight}
          alt={alt}
        />
      </InkPictureProvider>
      {link}
    </Box>
  )
}
