import * as React from 'react'
import { useState, useEffect } from 'react'
import { saveKiroAuthTokens, getKiroAccessToken, autoDetectKiroAuth } from '../utils/auth.js'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/select.js'

type KiroLoginFlowProps = {
  onDone: () => void
  startingMessage?: string
}

type LoginMode = 'menu' | 'device_code' | 'import_token' | 'auto_detect'

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
  const [autoDetectedData, setAutoDetectedData] = useState<{
    refreshToken: string
    profileArn?: string
    clientId?: string
    clientSecret?: string
    region?: string
    authMethod?: string
    source?: 'cli' | 'ide'
  } | null>(null)

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
      setStatus('Device code flow not yet implemented. Use "Import Token" or "Auto-detect" for now.')
      // For now, just show a message
      await new Promise(resolve => setTimeout(resolve, 2000))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleAutoDetect(): Promise<void> {
    setIsBusy(true)
    setStatus(null)
    try {
      const result = await autoDetectKiroAuth()
      if (!result.found) {
        setStatus(result.error || 'Auto-detection failed. Try manual import.')
        setMode('menu')
        return
      }

      setAutoDetectedData({
        refreshToken: result.refreshToken!,
        profileArn: result.profileArn,
        clientId: result.clientId,
        clientSecret: result.clientSecret,
        region: result.region,
        authMethod: result.authMethod,
        source: result.source,
      })
      setMode('auto_detect')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
      setMode('menu')
    } finally {
      setIsBusy(false)
    }
  }

  async function handleConfirmAutoDetect(): Promise<void> {
    if (!autoDetectedData) return

    setIsBusy(true)
    setStatus(null)
    try {
      await saveKiroAuthTokens({
        accessToken: '',
        refreshToken: autoDetectedData.refreshToken,
        profileArn: autoDetectedData.profileArn || null,
        region: autoDetectedData.region || 'us-east-1',
      })
      onDone()
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

  if (mode === 'auto_detect' && autoDetectedData) {
    const sourceLabel = autoDetectedData.source === 'cli' ? 'kiro-cli' : 'Kiro IDE'
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          Auto-detected Kiro credentials:
          {'\n'}
          <Text dimColor={true}>
            Source: {sourceLabel} ({autoDetectedData.authMethod === 'social' ? 'GitHub/Google' : autoDetectedData.authMethod === 'idc' ? 'IDC (Organization)' : 'AWS Builder ID'})
            {autoDetectedData.region ? ` | Region: ${autoDetectedData.region}` : ''}
            {autoDetectedData.clientId ? ' | Client ID: found' : ''}
            {autoDetectedData.profileArn ? ' | Profile ARN: found' : ''}
          </Text>
        </Text>
        <Text dimColor={true}>
          Refresh token: {autoDetectedData.refreshToken.slice(0, 12)}...{autoDetectedData.refreshToken.slice(-8)}
        </Text>
        {status ? <Text color="error">{status}</Text> : null}
        <Box>
          <Select
            options={[
              {
                label: (
                  <Text>
                    Use these credentials{' '}
                    <Text dimColor={true}>Save and continue</Text>
                    {'\n'}
                  </Text>
                ),
                value: 'confirm',
              },
              {
                label: (
                  <Text>
                    Cancel{' '}
                    <Text dimColor={true}>Go back to menu</Text>
                    {'\n'}
                  </Text>
                ),
                value: 'cancel',
              },
            ]}
            onChange={value => {
              if (value === 'confirm') {
                void handleConfirmAutoDetect()
              } else {
                setMode('menu')
                setAutoDetectedData(null)
              }
            }}
          />
        </Box>
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
          'Codev can use Kiro free models via AWS Builder ID or imported token.'}
      </Text>
      <Text dimColor={true}>
        Free models require AWS authentication. Import a refresh token if you already have one.
        {'\n'}
        Inference requires 9router running locally (or set KIRO_BASE_URL to a 9router instance).
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
                  Auto-detect from kiro-cli / Kiro IDE{' '}
                  <Text dimColor={true}>Reads AWS SSO cache + profile (recommended)</Text>
                  {'\n'}
                </Text>
              ),
              value: 'auto_detect',
            },
            {
              label: (
                <Text>
                  Import Refresh Token{' '}
                  <Text dimColor={true}>Paste existing token from kiro-cli / Kiro IDE</Text>
                  {'\n'}
                </Text>
              ),
              value: 'import_token',
            },
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
          ]}
          onChange={value => {
            if (value === 'device_code') {
              void handleDeviceCodeFlow()
            } else if (value === 'import_token') {
              setInputValue('')
              setCursorOffset(0)
              setMode('import_token')
            } else if (value === 'auto_detect') {
              void handleAutoDetect()
            }
          }}
        />
      </Box>
    </Box>
  )
}