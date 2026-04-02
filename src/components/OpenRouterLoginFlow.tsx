import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../ink.js'
import { saveOpenRouterApiKey } from '../utils/auth.js'
import { Spinner } from './Spinner.js'
import TextInput from './TextInput.js'

type OpenRouterLoginFlowProps = {
  onDone: () => void
  startingMessage?: string
}

export function OpenRouterLoginFlow({
  onDone,
  startingMessage,
}: OpenRouterLoginFlowProps): React.ReactNode {
  const [isBusy, setIsBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)

  async function handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) {
      return
    }

    setIsBusy(true)
    setStatus(null)
    try {
      await saveOpenRouterApiKey(trimmed)
      onDone()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  if (isBusy) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Spinner />
          <Text>Configuring OpenRouter login for Better-Clawd...</Text>
        </Box>
        <Text dimColor={true}>
          OpenRouter support uses your OpenRouter API key with the
          Anthropic-compatible Messages API endpoint.
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        {startingMessage ??
          'Better-Clawd can use OpenRouter with your OpenRouter API key.'}
      </Text>
      <Text dimColor={true}>
        Paste your OpenRouter key to use the Anthropic-compatible OpenRouter base
        URL at `https://openrouter.ai/api`.
      </Text>
      <Box>
        <Text>Paste your OpenRouter API key:</Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          onExit={() => {
            setInputValue('')
            setCursorOffset(0)
          }}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          columns={72}
          mask="*"
        />
      </Box>
      {status ? <Text color="error">{status}</Text> : null}
      <Text dimColor={true}>
        Press <Text bold={true}>Enter</Text> to save, or <Text bold={true}>Esc</Text>{' '}
        to cancel.
      </Text>
    </Box>
  )
}
