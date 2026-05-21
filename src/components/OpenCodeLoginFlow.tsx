import * as React from 'react'
import { useState, useEffect } from 'react'
import { saveOpenCodeApiKey, getOpenCodeApiKey } from '../utils/auth.js'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/select.js'

type OpenCodeLoginFlowProps = {
  onDone: () => void
  startingMessage?: string
}

type LoginMode = 'menu' | 'api_key'

export function OpenCodeLoginFlow({
  onDone,
  startingMessage,
}: OpenCodeLoginFlowProps): React.ReactNode {
  const [mode, setMode] = useState<LoginMode>('menu')
  const [isBusy, setIsBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [existingApiKey, setExistingApiKey] = useState<string | null>(null)

  useEffect(() => {
    const key = getOpenCodeApiKey()
    if (key) {
      setExistingApiKey(key)
    }
  }, [])

  async function handleFreeModels(): Promise<void> {
    setIsBusy(true)
    setStatus(null)
    try {
      await saveOpenCodeApiKey('public', '')
      onDone()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleSubmit(value?: string): Promise<void> {
    const trimmed = value?.trim() || ''
    const keyToSave = trimmed || existingApiKey

    if (!keyToSave) {
      return
    }

    setIsBusy(true)
    setStatus(null)
    try {
      await saveOpenCodeApiKey(keyToSave, '')
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
        <Text>Configuring OpenCode Zen for Better-Clawd...</Text>
      </Box>
    )
  }

  if (mode === 'api_key') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          OpenCode Zen API keys use pay-as-you-go billing.
          {'\n'}
          Sign up at opencode.ai/zen to get your key.
        </Text>
        <Box>
          <Text>Paste your OpenCode Zen API key:</Text>
          <TextInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
            onExit={() => {
              setMode('menu')
              setInputValue('')
              setCursorOffset(0)
            }}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={72}
            mask="*"
            focus={true}
            placeholder={existingApiKey || undefined}
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

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold={true}>
        {startingMessage ??
          'Better-Clawd can use OpenCode Zen free models or with a Zen API key.'}
      </Text>
      <Text dimColor={true}>
        Free models require no API key. Use an API key to access paid models.
        {'\n'}
        After login, use /model to pick a specific model.
      </Text>
      {status ? <Text color="error">{status}</Text> : null}
      <Box>
        <Select
          options={[
            {
              label: (
                <Text>
                  Use free models{' '}
                  <Text dimColor={true}>No API key required</Text>
                  {'\n'}
                </Text>
              ),
              value: 'free_models',
            },
            {
              label: (
                <Text>
                  Paste OpenCode Zen API key{' '}
                  <Text dimColor={true}>Access paid models, pay-as-you-go</Text>
                  {'\n'}
                </Text>
              ),
              value: 'api_key',
            },
          ]}
          onChange={value => {
            if (value === 'free_models') {
              void handleFreeModels()
            } else {
              setInputValue('')
              setCursorOffset(0)
              setMode('api_key')
            }
          }}
        />
      </Box>
    </Box>
  )
}
