import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../ink.js'
import {
  importOpenAIAuthFromCodexCache,
  runCodexLogin,
  saveOpenAIApiKey,
  saveOpenAIAuthTokens,
} from '../utils/auth.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'
import { Spinner } from './Spinner.js'

type OpenAILoginFlowProps = {
  onDone: () => void
  startingMessage?: string
}

type LoginMode = 'menu' | 'api_key' | 'access_token'

export function OpenAILoginFlow({
  onDone,
  startingMessage,
}: OpenAILoginFlowProps): React.ReactNode {
  const [mode, setMode] = useState<LoginMode>('menu')
  const [isBusy, setIsBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)

  const menuOptions = [
    {
      label: (
        <Text>
          Use cached Codex login{' '}
          <Text dimColor={true}>Import `~/.codex/auth.json`</Text>
          {'\n'}
        </Text>
      ),
      value: 'import_cache',
    },
    {
      label: (
        <Text>
          Sign in with Codex in browser{' '}
          <Text dimColor={true}>Runs `codex login`</Text>
          {'\n'}
        </Text>
      ),
      value: 'browser_login',
    },
    {
      label: (
        <Text>
          Sign in with device code{' '}
          <Text dimColor={true}>Runs `codex login --device-auth`</Text>
          {'\n'}
        </Text>
      ),
      value: 'device_login',
    },
    {
      label: (
        <Text>
          Paste OpenAI API key{' '}
          <Text dimColor={true}>Usage-based billing</Text>
          {'\n'}
        </Text>
      ),
      value: 'api_key',
    },
    {
      label: (
        <Text>
          Paste Codex access token{' '}
          <Text dimColor={true}>Manual fallback for ChatGPT auth</Text>
          {'\n'}
        </Text>
      ),
      value: 'access_token',
    },
  ] as const

  async function handleMenuSelection(value: string): Promise<void> {
    setStatus(null)

    if (value === 'api_key') {
      setInputValue('')
      setCursorOffset(0)
      setMode('api_key')
      return
    }

    if (value === 'access_token') {
      setInputValue('')
      setCursorOffset(0)
      setMode('access_token')
      return
    }

    setIsBusy(true)
    try {
      if (value === 'import_cache') {
        await importOpenAIAuthFromCodexCache()
      } else if (value === 'browser_login') {
        await runCodexLogin()
      } else if (value === 'device_login') {
        await runCodexLogin({ deviceAuth: true })
      }
      onDone()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) {
      return
    }

    setIsBusy(true)
    setStatus(null)
    try {
      if (mode === 'api_key') {
        await saveOpenAIApiKey(trimmed)
      } else {
        saveOpenAIAuthTokens({ accessToken: trimmed })
      }
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
          <Text>Configuring OpenAI login for Better-Clawd…</Text>
        </Box>
        <Text dimColor={true}>
          ChatGPT login uses Codex&apos;s shared auth cache and API-key login uses
          your OpenAI Platform key.
        </Text>
      </Box>
    )
  }

  if (mode === 'api_key' || mode === 'access_token') {
    const prompt =
      mode === 'api_key'
        ? 'Paste your OpenAI API key:'
        : 'Paste your Codex access token:'

    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          {mode === 'api_key'
            ? 'OpenAI API keys use standard platform billing.'
            : 'Codex access tokens are cached by Codex after ChatGPT login.'}
        </Text>
        <Box>
          <Text>{prompt}</Text>
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
      <Text>
        {startingMessage ??
          'Better-Clawd can use OpenAI via ChatGPT-managed Codex login or with a standard OpenAI API key.'}
      </Text>
      <Text dimColor={true}>
        Codex shares cached credentials between the CLI and IDE. If browser login
        is unavailable, device-auth and auth-cache import are supported too.
      </Text>
      {status ? <Text color="error">{status}</Text> : null}
      <Box>
        <Select
          options={menuOptions}
          onChange={value => {
            void handleMenuSelection(value)
          }}
        />
      </Box>
    </Box>
  )
}
