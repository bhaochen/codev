import * as React from 'react'
import { useState, useEffect } from 'react'
import { saveKiroAuthTokens, getKiroAccessToken } from '../utils/auth.js'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/select.js'

type KiroLoginFlowProps = {
  onDone: () => void
  startingMessage?: string
}

type LoginMode = 'menu' | 'device_code' | 'import_token'

export function KiroLoginFlow({
  onDone,
  startingMessage,
}: KiroLoginFlowProps): React.ReactNode {
  const [mode, setMode] = useState<LoginMode>('menu')
  const [isBusy, setIsBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [existingAccessToken, setExistingAccessToken] = useState<string | null>(null)

  useEffect(() => {
    const token = getKiroAccessToken()
    if (token) {
      setExistingAccessToken(token)
    }
  }, [])

  async function handleDeviceCodeFlow(): Promise<void> {
    setIsBusy(true)
    setStatus(null)
    try {
      // TODO: Implement AWS SSO OIDC device code flow
      // This requires:
      // 1. Register client with AWS SSO OIDC
      // 2. Start device authorization
      // 3. Poll for token
      // 4. Get profile ARN from CodeWhisperer
      // 5. Save tokens
      setStatus('Device code flow not yet implemented. Use "Import Token" for now.')
      // For now, just show a message
      await new Promise(resolve => setTimeout(resolve, 2000))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleImportToken(): Promise<void> {
    setIsBusy(true)
    setStatus(null)
    try {
      const trimmed = inputValue.trim()
      if (!trimmed) {
        setStatus('Please paste a refresh token')
        return
      }

      // Validate token format (Kiro refresh tokens start with "aorAAAAAG")
      if (!trimmed.startsWith('aorAAAAAG')) {
        setStatus('Invalid token format. Kiro refresh tokens should start with "aorAAAAAG..."')
        return
      }

      // TODO: Validate token by calling refresh endpoint
      // For now, save the token directly
      await saveKiroAuthTokens({
        accessToken: '', // Will be populated on first refresh
        refreshToken: trimmed,
        profileArn: null,
        region: 'us-east-1',
      })
      onDone()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleSubmit(value?: string): Promise<void> {
    const trimmed = value?.trim() || ''
    if (!trimmed) return

    if (mode === 'import_token') {
      setInputValue(trimmed)
      await handleImportToken()
    }
  }

  if (isBusy) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Configuring Kiro for Codev...</Text>
        {status && <Text color="error">{status}</Text>}
      </Box>
    )
  }

  if (mode === 'import_token') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          Import Kiro Refresh Token
          {'\n'}
          Get your refresh token from Kiro IDE or AWS CLI.
        </Text>
        <Box>
          <Text>Paste your Kiro refresh token (starts with aorAAAAAG):</Text>
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
            placeholder={existingAccessToken ? 'Already configured' : undefined}
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
          'Codev can use Kiro (Amazon Q) free models via AWS Builder ID or imported token.'}
      </Text>
      <Text dimColor={true}>
        Free models require AWS authentication. Import a refresh token if you already have one.
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
                  AWS Builder ID / IDC (Device Code Flow){' '}
                  <Text dimColor={true}>Sign in via browser (not yet implemented)</Text>
                  {'\n'}
                </Text>
              ),
              value: 'device_code',
            },
            {
              label: (
                <Text>
                  Import Refresh Token{' '}
                  <Text dimColor={true}>Paste existing token from Kiro IDE</Text>
                  {'\n'}
                </Text>
              ),
              value: 'import_token',
            },
          ]}
          onChange={value => {
            if (value === 'device_code') {
              void handleDeviceCodeFlow()
            } else if (value === 'import_token') {
              setInputValue('')
              setCursorOffset(0)
              setMode('import_token')
            }
          }}
        />
      </Box>
    </Box>
  )
}