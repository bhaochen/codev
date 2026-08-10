import * as React from 'react'
import { useState, useEffect } from 'react'
import { Box, Text } from '../ink.js'
import {
  importOpenAIAuthFromCodexCache,
  runCodexLogin,
  saveOpenAIApiKey,
  saveOpenAIAuthTokens,
  getOpenAIApiKey,
} from '../utils/auth.js'
import {
  requestChatGPTDeviceCode,
  completeChatGPTDeviceLogin,
  type ChatGPTDeviceCode,
} from '../services/api/openai/index.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'
import { Spinner } from './Spinner.js'

type OpenAILoginFlowProps = {
  onDone: () => void
  startingMessage?: string
}

type LoginMode = 'menu' | 'api_key' | 'access_token' | 'chatgpt_device'

export function OpenAILoginFlow({
  onDone,
  startingMessage,
}: OpenAILoginFlowProps): React.ReactNode {
  const [mode, setMode] = useState<LoginMode>('menu')
  const [isBusy, setIsBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [existingApiKey, setExistingApiKey] = useState<string | null>(null)
  const [deviceCode, setDeviceCode] = useState<ChatGPTDeviceCode | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)

  useEffect(() => {
    const key = getOpenAIApiKey()
    if (key) {
      setExistingApiKey(key)
    }
  }, [])

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
          Sign in with ChatGPT subscription{' '}
          <Text dimColor={true}>Native device flow (no Codex CLI)</Text>
          {'\n'}
        </Text>
      ),
      value: 'chatgpt_device',
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

    if (value === 'chatgpt_device') {
      setIsBusy(true)
      setStatus(null)
      setDeviceError(null)
      try {
        const code = await requestChatGPTDeviceCode()
        setDeviceCode(code)
        setMode('chatgpt_device')
      } catch (error) {
        setDeviceError(error instanceof Error ? error.message : String(error))
      } finally {
        setIsBusy(false)
      }
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

  // 进入 chatgpt_device 模式且拿到 device code 后，后台轮询授权并换取 token。
  useEffect(() => {
    if (mode !== 'chatgpt_device' || !deviceCode) {
      return
    }
    let cancelled = false
    const controller = new AbortController()
    ;(async () => {
      try {
        await completeChatGPTDeviceLogin(deviceCode, controller.signal)
        if (!cancelled) {
          onDone()
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setDeviceError(
            error instanceof Error ? error.message : String(error),
          )
          setMode('menu')
          setDeviceCode(null)
        }
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, deviceCode])

  async function handleSubmit(value?: string): Promise<void> {
    if (!value && mode === 'api_key' && !existingApiKey) {
      return
    }
    
    const trimmed = value?.trim() || ''
    const keyToSave = mode === 'api_key' ? (trimmed || existingApiKey) : trimmed
    
    if (!keyToSave) {
      return
    }

    setIsBusy(true)
    setStatus(null)
    try {
      if (mode === 'api_key') {
        await saveOpenAIApiKey(keyToSave)
      } else {
        saveOpenAIAuthTokens({ accessToken: keyToSave })
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

  if (mode === 'chatgpt_device') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          Sign in to your ChatGPT account (subscription required) at:
        </Text>
        <Text bold={true}>{deviceCode?.verificationUrl ?? ''}</Text>
        <Text>
          and enter the code:{' '}
          <Text bold={true}>{deviceCode?.userCode ?? ''}</Text>
        </Text>
        <Box>
          <Spinner />
          <Text>Waiting for browser authorization…</Text>
        </Box>
        {deviceError ? <Text color="error">{deviceError}</Text> : null}
        <Text dimColor={true}>
          Press <Text bold={true}>Esc</Text> to cancel. After logging in, set{' '}
          <Text bold={true}>OPENAI_AUTH_MODE=chatgpt</Text> to use your ChatGPT
          subscription as the query backend.
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
            focus={true}
            placeholder={mode === 'api_key' ? existingApiKey || undefined : undefined}
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
