/**
 * /friend TUI command — manage VRM desktop pet companion.
 *
 * Ink-based terminal UI that shows status and controls for the
 * Friend desktop pet feature.
 */
import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getPrefs, updatePrefs } from '../../friend/prefs.js'
import {
  launchTauri,
  stopTauri,
  getTauriProcess,
} from '../../friend/tauri-launcher.js'
import type { LocalJSXCommandOnDone, CommandResultDisplay } from '../../types/command.js'

const FRIEND_URL = 'http://127.0.0.1:3456/friend/'

const logger = () => ({
  info: (msg: string) => console.log(`[Friend] ${msg}`),
  warn: (msg: string) => console.warn(`[Friend] ${msg}`),
})

type Page = 'status' | 'help'

export async function call(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = args?.trim().toLowerCase()

  if (trimmed === 'start') {
    updatePrefs({ enabled: true })
    launchTauri(logger())
    return <FriendStartView onDone={onDone} />
  }

  if (trimmed === 'stop') {
    updatePrefs({ enabled: false })
    stopTauri(logger())
    return <FriendStopView onDone={onDone} />
  }

  if (trimmed === 'status') {
    const prefs = getPrefs()
    return <FriendStatus prefs={prefs} compact />
  }

  return <FriendManager onDone={onDone} />
}

function FriendManager({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const [page, setPage] = useState<Page>('status')

  useInput((_input, key) => {
    if (key.escape || key.return) {
      onDone()
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold underline>
          Friend VRM Desktop Pet
        </Text>
      </Box>

      <FriendStatus prefs={getPrefs()} compact={false} />

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Usage:</Text>
        <Text dimColor>  /friend         Interactive status & controls</Text>
        <Text dimColor>  /friend start   Launch friend window</Text>
        <Text dimColor>  /friend stop    Stop friend window</Text>
        <Text dimColor>  /friend status  Quick status overview</Text>
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
  compact,
}: {
  prefs: ReturnType<typeof getPrefs>
  compact: boolean
}) {
  const statusDot = prefs.enabled ? '●' : '○'
  const statusColor = prefs.enabled ? 'green' : 'gray'
  const running = !!getTauriProcess()

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={statusColor}>{statusDot} Status: </Text>
        <Text bold color={statusColor}>
          {prefs.enabled ? 'Enabled' : 'Disabled'}
        </Text>
      </Box>
      {!compact && (
        <>
          {running && (
            <Box>
              <Text>  Window: </Text>
              <Text color="green">Running</Text>
            </Box>
          )}
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
        </>
      )}
    </Box>
  )
}