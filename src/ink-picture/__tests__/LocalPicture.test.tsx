#!/usr/bin/env bun
/**
 * Visual test: display a local image using ink-picture + Ink.
 *
 * Usage:
 *   bun run src/ink-picture/__tests__/LocalPicture.test.tsx
 */

import React, { useEffect } from 'react'
import { render, Box, useApp } from 'ink'
import Image, { InkPictureProvider } from '../index.ts'

const IMAGE_PATH = '/home/yuki/Pictures/Wallpapers/3god.jpg'

const cols = process.stdout.columns ?? 80
const rows = process.stdout.rows ?? 40
const imgWidth = Math.floor(cols * 0.6)
const imgHeight = Math.floor(rows * 0.4)

function App() {
  const { exit } = useApp()

  useEffect(() => {
    const timer = setTimeout(() => exit(), 3000)
    return () => clearTimeout(timer)
  }, [exit])

  return (
    <Box flexDirection="column">
      <InkPictureProvider>
        <Image src={IMAGE_PATH} width={imgWidth} height={imgHeight} alt="3god" />
      </InkPictureProvider>
    </Box>
  )
}

const { waitUntilExit } = render(<App />)
await waitUntilExit()