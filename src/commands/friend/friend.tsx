/**
 * /friend TUI command — manage VRM desktop pet companion.
 *
 * Ink-based terminal UI that shows status and controls for the
 * Friend desktop pet feature.
 */
import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getPrefs, updatePrefs } from '../../friend/prefs.js'
import type { LocalJSXCommandOnDone, CommandResultDisplay } from '../../commands.js'

const FRIEND_URL = 'http://127.0.0.1:3456/friend/'

type Page = 'status' | 'help'

export async function call(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = args?.trim().toLowerCase()

  // Non-interactive modes
  if (trimmed === 'start') {
    updatePrefs({ enabled: true })
    return (
      <Box flexDirection="column">
        <Text>Friend companion enabled.</Text>
        <Text>Start the server with:</Text>
        <Text>  bun run src/server/index.ts --port 3456</Text>
        <Text>Then open {FRIEND_URL} in a browser (or Tauri will launch automatically).</Text>
      </Box>
    )
  }

  if (trimmed === 'stop') {
    updatePrefs({ enabled: false })
    return <Text>Friend companion disabled.</Text>
  }

  if (trimmed === 'status') {
    const prefs = getPrefs()
    return <FriendStatus prefs={prefs} compact />
  }

  // Interactive mode (no args or unrecognized)
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
          {page === 'status' ? '🄵 Friend VRM Desktop Pet' : 'Help'}
        </Text>
      </Box>

      {page === 'status' && <FriendStatus prefs={getPrefs()} compact={false} />}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Usage:</Text>
        <Text dimColor>  /friend         Interactive status &amp; controls</Text>
        <Text dimColor>  /friend start   Enable &amp; launch friend</Text>
        <Text dimColor>  /friend stop    Disable friend</Text>
        <Text dimColor>  /friend status  Quick status overview</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Press Esc or Enter to close.</Text>
      </Box>
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
