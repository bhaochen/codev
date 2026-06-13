import * as React from 'react'
import { useState, useEffect } from 'react'
import { Box, Text } from '../ink.js'
import { saveNvidiaApiKey, getNvidiaApiKey } from '../utils/auth.js'
import { Spinner } from './Spinner.js'
import TextInput from './TextInput.js'

type NvidiaLoginFlowProps = {
  onDone: () => void
  startingMessage?: string
}

export function NvidiaLoginFlow({
  onDone,
  startingMessage,
}: NvidiaLoginFlowProps): React.ReactNode {
  const [isBusy, setIsBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [existingKey, setExistingKey] = useState<string | null>(null)

  useEffect(() => {
    const key = getNvidiaApiKey()
    if (key) {
      setExistingKey(key)
    }
  }, [])

  async function handleSubmit(value?: string): Promise<void> {
    if (!value && !existingKey) {
      setStatus('Please enter an API key or press Esc to cancel')
      return
    }

    const trimmed = value?.trim() || ''
    const keyToSave = trimmed || existingKey || ''

    if (!keyToSave) {
      setStatus('Please enter an API key or press Esc to cancel')
      return
    }

    setIsBusy(true)
    setStatus(null)
    try {
      await saveNvidiaApiKey(keyToSave)
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
          <Text>Configuring NVIDIA login for Better-Clawd...</Text>
        </Box>
        <Text dimColor={true}>
          NVIDIA GPU-accelerated models are accessed via the NVIDIA API
          catalog at `https://integrate.api.nvidia.com/v1`.
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        {startingMessage ??
          'Better-Clawd can use NVIDIA with your NVIDIA API key.'}
      </Text>
      <Text dimColor={true}>
        Paste your NVIDIA API key to use models from the NVIDIA API catalog
        via the OpenAI-compatible endpoint.
      </Text>
      <Box>
        <Text>Paste your NVIDIA API key:</Text>
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
          focus={true}
          placeholder={existingKey || undefined}
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
