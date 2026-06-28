/**
 * /friend TUI command — manage VRM desktop pet companion.
 *
 * Ink-based terminal UI that shows status and controls for the
 * Friend desktop pet feature.
 */
import React, { useEffect } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getPrefs, updatePrefs } from '../../friend/prefs.js'
import {
  launchTauri,
  stopTauri,
} from '../../friend/tauri-launcher.js'
import { startFriendServer, stopFriendServer, getServerPort } from '../../friend/server.js'
import { friendService } from '../../friend/FriendService.js'
import type { LocalJSXCommandOnDone, CommandResultDisplay } from '../../types/command.js'

const FRIEND_URL = 'http://127.0.0.1:3456/friend/'

const logger = () => ({
  info: (msg: string) => console.log(`[Friend] ${msg}`),
  warn: (msg: string) => console.warn(`[Friend] ${msg}`),
})

export async function call(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = args?.trim().toLowerCase()

  // /friend (no args) or /friend start → start the service
  if (!trimmed || trimmed === 'start') {
    updatePrefs({ enabled: true })
    // Start in-process HTTP server for friend API and SSE
    try {
      startFriendServer(3456, '127.0.0.1')
    } catch (err) {
      console.warn(`[Friend] HTTP server start failed: ${err}`)
      console.warn('[Friend] The Tauri app may need the main server on port 3456.')
    }
    // FriendService runs in-process; messages enqueue into the CLI queue
    await friendService.start().catch((err) => {
      console.warn(`[Friend] Service start failed: ${err}`)
    })
    // Launch Tauri display window (thin client)
    launchTauri(logger())
    return <FriendStartView onDone={onDone} />
  }

  if (trimmed === 'stop') {
    updatePrefs({ enabled: false })
    await friendService.stop().catch(() => {})
    stopFriendServer()
    stopTauri(logger())
    return <FriendStopView onDone={onDone} />
  }

  // /friend help → show manager/status view
  return <FriendManager onDone={onDone} />
}

function FriendManager({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  useInput((_input, key) => {
    if (key.escape || key.return) {
      onDone(undefined, { display: 'skip' })
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold underline>
          Friend VRM Desktop Pet
        </Text>
      </Box>

      <FriendStatus prefs={getPrefs()} />

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Usage:</Text>
        <Text dimColor>  /friend         Interactive status & controls</Text>
        <Text dimColor>  /friend start   Launch friend window</Text>
        <Text dimColor>  /friend stop    Stop friend window</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Press Esc or Enter to close.</Text>
      </Box>
    </Box>
  )
}

function FriendStopView({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  useEffect(() => {
    const t = setTimeout(() => onDone(undefined, { display: 'skip' }), 1500)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <Box flexDirection="column">
      <Text>Friend companion stopped.</Text>
    </Box>
  )
}

function FriendStartView({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  useEffect(() => {
    const t = setTimeout(() => onDone(undefined, { display: 'skip' }), 1500)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <Box flexDirection="column">
      <Text>Starting Friend VRM companion...</Text>
      <Text dimColor>A Tauri window will open.</Text>
      <Text dimColor>Also available at: {FRIEND_URL}</Text>
    </Box>
  )
}

function FriendStatus({
  prefs,
}: {
  prefs: ReturnType<typeof getPrefs>
}) {
  const statusDot = prefs.enabled ? '●' : '○'
  const statusColor = prefs.enabled ? 'green' : 'gray'

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={statusColor}>{statusDot} Status: </Text>
        <Text bold color={statusColor}>
          {prefs.enabled ? 'Enabled' : 'Disabled'}
        </Text>
      </Box>
      <Box>
        <Text>  URL: </Text>
        <Text dimColor>{FRIEND_URL}</Text>
      </Box>
      <Box>
        <Text>  Voice: </Text>
        <Text dimColor>{prefs.voice ?? 'default'}</Text>
      </Box>
      <Box>
        <Text>  TTS: </Text>
        <Text dimColor>{prefs.ttsEnabled ? 'on' : 'off'}</Text>
      </Box>
      <Box>
        <Text>  Tracking: </Text>
        <Text dimColor>{prefs.tracking ?? 'mouse'}</Text>
      </Box>
    </Box>
  )
}