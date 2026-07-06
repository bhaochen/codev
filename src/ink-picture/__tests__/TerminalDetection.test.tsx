#!/usr/bin/env bun
/**
 * Terminal capability detection diagnostic test.
 *
 * Shows what ink-picture detects about the current terminal:
 * env vars, escape sequence query results, and the final protocol.
 *
 * Usage:
 *   bun run src/ink-picture/__tests__/TerminalDetection.test.tsx
 */

import React, { useEffect, useState } from 'react'
import { render, Box, Text, useApp } from 'ink'
import Image, {
  InkPictureProvider,
  type TerminalInfo,
  useTerminalInfo,
} from '../index.ts'

/**
 * Probe Kitty graphics protocol directly via raw escape sequences.
 * Uses fs.writeSync to stdout and intercepts stdin responses,
 * bypassing Ink's input pipeline.
 */
async function probeKittyDirect(): Promise<{ protocol: string }> {
  return new Promise(resolve => {
    const result = { protocol: 'no-response' }

    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      resolve(result)
      return
    }

    const origPush = process.stdin.push.bind(process.stdin)
    let resolved = false

    const finish = (label: string) => {
      if (resolved) return
      resolved = true
      process.stdin.push = origPush as any
      result.protocol = label
      resolve(result)
    }

    process.stdin.push = ((chunk: any) => {
      const str = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)

      // Kitty OK response
      if (/\x1b_Gi=31;OK\x1b\\/.test(str)) {
        finish('kitty-ok')
        return origPush(chunk)
      }

      // DA1 sentinel — kitty response should arrive before or with DA1
      if (/\x1b\[\?(\d+(?:;\d+)*)c/.test(str)) {
        // Give kitty response a chance if it arrived in same chunk after DA
        setTimeout(() => finish('no-kitty'), 200)
      }

      return origPush(chunk)
    }) as any

    const query =
      '\x1b[8m' +
      '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\' +
      '\x1b[c' +
      '\x1b[2K\r' +
      '\x1b[0m'

    try {
      process.stdin.setRawMode?.(true)
      require('fs').writeSync(process.stdout.fd, query)
    } catch {}

    setTimeout(() => finish('timeout'), 2000)
  })
}

function DetectionApp() {
  const { exit } = useApp()
  const terminalInfo = useTerminalInfo()
  const [probeResult, setProbeResult] = useState<string>('probing...')

  useEffect(() => {
    probeKittyDirect().then(r => {
      setProbeResult(JSON.stringify(r))
    })
    const timer = setTimeout(() => exit(), 5000)
    return () => clearTimeout(timer)
  }, [exit])

  const env: Record<string, string | undefined> = {
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    TERM: process.env.TERM,
    KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
    GHOSTTY_RESOURCES_DIR: process.env.GHOSTTY_RESOURCES_DIR,
    TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION,
    COLORTERM: process.env.COLORTERM,
    WEZTERM_PANE: process.env.WEZTERM_PANE,
    KONSOLE_VERSION: process.env.KONSOLE_VERSION,
    XTERM_VERSION: process.env.XTERM_VERSION,
    VTE_VERSION: process.env.VTE_VERSION,
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold underline color="cyan">
        Terminal Detection Diagnostic
      </Text>
      <Text>{' '}</Text>

      <Text bold color="yellow">
        Environment Variables:
      </Text>
      {Object.entries(env).map(([k, v]) => (
        <Text key={k}>
          {'  '}
          {k}: {v ?? '(not set)'}
        </Text>
      ))}
      <Text>{' '}</Text>

      <Text bold color="yellow">
        Direct Kitty Probe (raw escape sequence):
      </Text>
      <Text>  {probeResult}</Text>
      <Text>{' '}</Text>

      <Text bold color="yellow">
        InkPictureProvider TerminalInfo:
      </Text>
      <Text>
        {'  '}supportsKittyGraphics: {String(terminalInfo.supportsKittyGraphics)}
      </Text>
      <Text>
        {'  '}supportsSixelGraphics: {String(terminalInfo.supportsSixelGraphics)}
      </Text>
      <Text>
        {'  '}supportsITerm2Graphics: {String(terminalInfo.supportsITerm2Graphics)}
      </Text>
      <Text>
        {'  '}supportsUnicode: {String(terminalInfo.supportsUnicode)}
      </Text>
      <Text>
        {'  '}supportsColor: {String(terminalInfo.supportsColor)}
      </Text>
      <Text>
        {'  '}cell: {terminalInfo.cellWidth}x{terminalInfo.cellHeight}
      </Text>
      <Text>
        {'  '}terminal: {terminalInfo.terminalWidth}x{terminalInfo.terminalHeight}
      </Text>
    </Box>
  )
}

const { waitUntilExit } = render(
  <InkPictureProvider>
    <DetectionApp />
  </InkPictureProvider>,
)
await waitUntilExit()