import React, { useContext, useEffect, useRef, useState } from 'react'
import Link from '../ink/components/Link.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { Box, Text } from '../ink.js'
import { TerminalWriteContext } from '../ink/useTerminalNotification.js'
import { downloadImage, type CachedImage } from '../utils/imageUrlCache.js'
import {
  detectImageProtocol,
  encodeImageForTerminal,
  isInsideTmux,
  type ImageProtocol,
} from '../utils/terminalImage.js'

type Props = {
  url: string
  alt?: string
}

type Status = 'loading' | 'ready' | 'error'

/**
 * Extract a display filename from a URL (for fallback text).
 */
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
 * Renders an inline image in the terminal using the Kitty graphics protocol
 * when available. Falls back to a clickable hyperlink for terminals without
 * image protocol support.
 *
 * Behavior:
 * - loading: dimmed "[Loading image...]" text + tmux passthrough notice
 * - ready + kitty protocol: writes escape sequence via Ink's writeRaw,
 *   shows clickable [Image] link
 * - ready + no protocol: shows clickable link with the URL
 * - error: shows clickable link with plain text fallback
 */
export function InlineImage({ url, alt }: Props) {
  const writeRaw = useContext(TerminalWriteContext)
  const [status, setStatus] = useState<Status>('loading')
  const [imageData, setImageData] = useState<CachedImage | null>(null)
  const [protocol, setProtocol] = useState<ImageProtocol>(() =>
    detectImageProtocol(),
  )
  const protocolRef = useRef(protocol)
  protocolRef.current = protocol
  const imageWrittenRef = useRef(false)

  const insideTmux = isInsideTmux()

  // Download image on mount
  useEffect(() => {
    let cancelled = false

    setStatus('loading')
    setImageData(null)
    setProtocol(detectImageProtocol())
    imageWrittenRef.current = false
    console.error(`[InlineImage] Starting download: ${url}`)

    downloadImage(url)
      .then(result => {
        if (cancelled) return
        console.error(`[InlineImage] Download result for ${url}:`, result ? `OK (${result.buffer.length} bytes, ${result.format})` : 'FAILED')
        if (result) {
          setImageData(result)
          setStatus('ready')
        } else {
          setStatus('error')
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error(`[InlineImage] Download error for ${url}:`, err)
          setStatus('error')
        }
      })

    return () => {
      cancelled = true
    }
  }, [url])

  // Write terminal image escape sequence via Ink's writeRaw (not raw stdout)
  // so it stays synchronous with Ink's output and avoids cursor-position races.
  useEffect(() => {
    if (status !== 'ready' || !imageData || !protocol || imageWrittenRef.current) return

    const sequence = encodeImageForTerminal(imageData.buffer, imageData.format)
    if (sequence && writeRaw) {
      console.error(`[InlineImage] Writing ${imageData.buffer.length} byte ${imageData.format} image via writeRaw`)
      writeRaw(sequence)
      imageWrittenRef.current = true
    } else if (!writeRaw) {
      console.error(`[InlineImage] writeRaw not available!`)
    } else {
      console.error(`[InlineImage] No sequence generated`)
    }
  }, [status, imageData, protocol, writeRaw])

  const displayName = alt || filenameFromUrl(url)

  // -- Render states --

  // Loading: dimmed placeholder text
  if (status === 'loading') {
    if (insideTmux) {
      return (
        <Text dimColor>
          {`[Loading ${displayName}...] (tmux may need allow-passthrough on)`}
        </Text>
      )
    }
    return <Text dimColor>{`[Loading ${displayName}...]`}</Text>
  }

  // Error: clickable link or plain text
  if (status === 'error') {
    if (supportsHyperlinks()) {
      return (
        <Link url={url}>
          <Text dimColor>{`[${displayName}]`}</Text>
        </Link>
      )
    }
    return <Text dimColor>{`[${displayName}: ${url}]`}</Text>
  }

  // Ready: if we have a protocol and wrote the sequence, render a small label.
  // The image was already written to the terminal via writeRaw above.
  const link = supportsHyperlinks() ? (
    <Link url={url}>
      <Text dimColor>{`[${displayName}]`}</Text>
    </Link>
  ) : (
    <Text dimColor>{`[${displayName}: ${url}]`}</Text>
  )

  return (
    <Box flexDirection="column">
      {link}
      {insideTmux && protocol && (
        <Text dimColor>{`  ⚠ tmux: add \`set -g allow-passthrough on\` to ~/.tmux.conf`}</Text>
      )}
    </Box>
  )
}
