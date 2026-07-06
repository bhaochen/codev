#!/usr/bin/env bun
/**
 * Visual test: display a local image using ink-picture + Ink.
 *
 * Usage:
 *   bun run src/tools/ImageShowTool/__tests__/ShowLocalImage.test.tsx
 */

import React, { useEffect } from 'react'
import { render, Box, Text, useApp } from 'ink'
import Image, { InkPictureProvider, type TerminalInfo } from 'src/ink-picture/index.ts'

const IMAGE_PATH = '/home/yuki/Pictures/Wallpapers/3god.jpg'

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
    const timer = setTimeout(() => exit(), 3000)
    return () => clearTimeout(timer)
  }, [exit])

  return (
    <Box flexDirection="column">
      <InkPictureProvider terminalInfo={terminalInfo}>
        <Image src={IMAGE_PATH} width={imgWidth} height={imgHeight} alt="3god" />
      </InkPictureProvider>
    </Box>
  )
}

const { waitUntilExit } = render(<App />)
await waitUntilExit()
