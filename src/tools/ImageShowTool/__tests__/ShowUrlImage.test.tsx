#!/usr/bin/env bun
/**
 * Visual test: display a remote image using ink-picture + Ink.
 *
 * Usage:
 *   bun run src/tools/ImageShowTool/__tests__/ShowUrlImage.test.tsx
 */

import React, { useEffect } from 'react'
import { render, Box, Text, useApp } from 'ink'
import Image, { InkPictureProvider, type TerminalInfo } from 'src/ink-picture/index.ts'

const IMAGE_URL =
  'https://kimi-web-img.moonshot.cn/img/images.pexels.com/8f909bffa5353ba43aac1db1f83b1bf5450a8cd5.jpeg'

const cols = process.stdout.columns ?? 80
const rows = process.stdout.rows ?? 40
const imgWidth = Math.floor(cols * 0.6)
const imgHeight = Math.floor(rows * 0.4)

const terminalInfo: Partial<TerminalInfo> = {
  supportsKittyGraphics: !!(
    process.env.TERM?.includes('kitty') ||
    process.env.KITTY_WINDOW_ID ||
    process.env.TERM_PROGRAM === 'kitty' ||
    process.env.TERM_PROGRAM === 'ghostty' ||
    process.env.TERM_PROGRAM === 'WezTerm' ||
    process.env.TERM_PROGRAM === 'konsole' ||
    process.env.TERM_PROGRAM === 'foot'
  ),
  supportsUnicode: true,
}

function App() {
  const { exit } = useApp()

  useEffect(() => {
    // Longer timeout for remote image (network fetch)
    const timer = setTimeout(() => exit(), 15000)
    return () => clearTimeout(timer)
  }, [exit])

  return (
    <Box flexDirection="column">
      <InkPictureProvider terminalInfo={terminalInfo}>
        <Image src={IMAGE_URL} width={imgWidth} height={imgHeight} alt="remote" />
      </InkPictureProvider>
    </Box>
  )
}

const { waitUntilExit } = render(<App />)
await waitUntilExit()
