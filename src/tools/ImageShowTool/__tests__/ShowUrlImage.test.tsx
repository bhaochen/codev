#!/usr/bin/env bun
/**
 * Visual test: display a remote image using ink-picture + Ink.
 *
 * Usage:
 *   bun run src/tools/ImageShowTool/__tests__/ShowUrlImage.test.tsx
 *   Press Ctrl+C to exit
 */

import React, { useEffect, useState } from 'react'
import { render, Box, Text, useApp } from 'ink'
import Image, { InkPictureProvider } from 'src/ink-picture/index.ts'
import { loadImageFromUrl } from 'src/ink-picture/utils/jimpURL.ts'

const IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/en/7/7d/Lenna_%28test_image%29.png'

const CELL_WIDTH = 8
const CELL_HEIGHT = 16

function App() {
  const { exit } = useApp()
  const [dims, setDims] = useState<{
    width: number
    height: number
    pixelWidth: number
    pixelHeight: number
  } | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const image = await loadImageFromUrl(IMAGE_URL)
        const origW = image.bitmap.width
        const origH = image.bitmap.height
        const cols = process.stdout.columns ?? 80

        const targetW_chars = Math.floor(cols * 0.6)
        const targetW_pixels = targetW_chars * CELL_WIDTH
        const targetH_pixels = Math.floor(targetW_pixels * (origH / origW))
        const minH_pixels = 3 * CELL_HEIGHT
        const finalH_pixels = Math.max(targetH_pixels, minH_pixels)
        const targetH_chars = Math.ceil(finalH_pixels / CELL_HEIGHT)

        setDims({ width: targetW_chars, height: targetH_chars, pixelWidth: targetW_pixels, pixelHeight: finalH_pixels })
      } catch {
        setErr(true)
        exit()
      }
    })()
  }, [exit])

  useEffect(() => {
    const handleSigint = () => exit()
    process.on('SIGINT', handleSigint)
    return () => process.off('SIGINT', handleSigint)
  }, [exit])

  if (err) return <Text color="red">Failed to load image: {IMAGE_URL}</Text>
  if (!dims) return <Text>Loading...</Text>

  return (
    <Box flexDirection="column">
      <InkPictureProvider>
        <Image src={IMAGE_URL} width={dims.width} height={dims.height} pixelWidth={dims.pixelWidth} pixelHeight={dims.pixelHeight} alt="remote" />
      </InkPictureProvider>
    </Box>
  )
}

const { waitUntilExit } = render(<App />)
await waitUntilExit()
