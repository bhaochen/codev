#!/usr/bin/env bun
/**
 * Visual test: display a local image using ink-picture + Ink.
 *
 * Usage:
 *   bun run src/tools/ImageShowTool/__tests__/ShowLocalImage.test.tsx
 *   Press Ctrl+C to exit
 */

import { Jimp } from 'jimp'
import React, { useEffect, useState } from 'react'
import { render, Box, Text, useApp } from 'ink'
import Image, { InkPictureProvider } from 'src/ink-picture/index.ts'

const IMAGE_PATH = '/home/yuki/Pictures/Wallpapers/3god.jpg'

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
        const image = await Jimp.read(IMAGE_PATH)
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

  if (err) return <Text color="red">Failed to load image</Text>
  if (!dims) return <Text>Loading...</Text>

  return (
    <Box flexDirection="column">
      <InkPictureProvider>
        <Image src={IMAGE_PATH} width={dims.width} height={dims.height} pixelWidth={dims.pixelWidth} pixelHeight={dims.pixelHeight} alt="3god" />
      </InkPictureProvider>
    </Box>
  )
}

const { waitUntilExit } = render(<App />)
await waitUntilExit()
