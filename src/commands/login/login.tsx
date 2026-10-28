import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getCustomApiConfig, saveCustomApiConfig } from '../../utils/auth.js'
import { clearStoredProviderCache } from '../../utils/model/providers.js'

type FieldKey = 'baseUrl' | 'apiKey' | 'modelName'

type FieldDef = {
  key: FieldKey
  label: string
  placeholder: string
  mask?: string
  optional?: boolean
}

const FIELDS: FieldDef[] = [
  {
    key: 'baseUrl',
    label: 'API Base URL',
    placeholder: 'http://localhost:8080/v1',
  },
  {
    key: 'apiKey',
    label: 'API Key',
    placeholder: 'press Enter to skip',
    mask: '*',
    optional: true,
  },
  {
    key: 'modelName',
    label: 'Model (optional)',
    placeholder: 'press Enter to skip',
    optional: true,
  },
]

/**
 * Probe an OpenAI-compatible endpoint's ``/v1/models`` so obviously wrong
 * URLs/keys fail fast. Best-effort: a failure is reported but never blocks
 * saving, since many endpoints don't expose ``/v1/models``.
 */
async function verifyEndpoint(baseUrl: string, apiKey: string): Promise<void> {
  const url = new URL(baseUrl)
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(`${url.origin}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  }
}

function LoginForm({
  onDone,
  onCancel,
}: {
  onDone: (message: string) => void
  onCancel: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const existing = React.useMemo(() => getCustomApiConfig(), [])
  const [index, setIndex] = React.useState(0)
  const [values, setValues] = React.useState<Partial<Record<FieldKey, string>>>({
    baseUrl: existing.baseUrl ?? '',
    apiKey: existing.apiKey ?? '',
    modelName: existing.modelName ?? '',
  })
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [status, setStatus] = React.useState<'editing' | 'saving' | 'error'>('editing')
  const [notice, setNotice] = React.useState('')
  const [error, setError] = React.useState('')

  const field = FIELDS[index]

  const submit = React.useCallback(
    async (vals: Partial<Record<FieldKey, string>>) => {
      const baseUrl = (vals.baseUrl ?? '').trim()
      const apiKey = (vals.apiKey ?? '').trim()
      const modelName = (vals.modelName ?? '').trim()

      if (!baseUrl) {
        setStatus('error')
        setError('API Base URL is required')
        setIndex(0)
        return
      }

      setStatus('saving')
      setError('')
      setNotice('')

      let noticeText = ''
      try {
        await verifyEndpoint(baseUrl, apiKey)
      } catch (verifyError) {
        noticeText = `Saved without verification (${
          verifyError instanceof Error ? verifyError.message : 'unknown error'
        })`
      }

      try {
        await saveCustomApiConfig(baseUrl, modelName, apiKey || undefined)
        clearStoredProviderCache()
        onDone(
          `Configured OpenAI-compatible endpoint: ${baseUrl}${modelName ? ` (model: ${modelName})` : ''}${
            noticeText ? ` · ${noticeText}` : ''
          }`,
        )
      } catch (saveError) {
        setStatus('error')
        setError(saveError instanceof Error ? saveError.message : String(saveError))
      }
    },
    [onDone],
  )

  const handleFieldSubmit = (value: string) => {
    const next = { ...values, [field.key]: value }
    setValues(next)
    if (index < FIELDS.length - 1) {
      setIndex(index + 1)
      setCursorOffset(0)
    } else {
      void submit(next)
    }
  }

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel()
      }
    },
    { isActive: status !== 'editing' },
  )

  return (
    <Dialog title="Login" onCancel={onCancel} isCancelActive={false}>
      <Box flexDirection="column" gap={1}>
        <Text bold>OpenAI-compatible endpoint</Text>
        <Text dimColor>
          Any OpenAI Chat Completions API (9router, OpenRouter, vLLM, llama.cpp, …).
        </Text>
        {FIELDS.map((item, itemIndex) => (
          <Box key={item.key} flexDirection="column">
            <Text dimColor={itemIndex !== index}>{item.label}</Text>
            {itemIndex === index && status === 'editing' ? (
              <TextInput
                value={values[item.key] ?? ''}
                onChange={value => setValues(prev => ({ ...prev, [item.key]: value }))}
                onChangeCursorOffset={setCursorOffset}
                onSubmit={handleFieldSubmit}
                onExit={onCancel}
                placeholder={item.placeholder}
                mask={item.mask}
                columns={columns}
                cursorOffset={cursorOffset}
                showCursor
                focus
              />
            ) : (
              <Text>
                {item.mask && values[item.key]
                  ? item.mask.repeat((values[item.key] ?? '').length)
                  : values[item.key] || <Text dimColor>(not set)</Text>}
              </Text>
            )}
          </Box>
        ))}
        {status === 'saving' && <Text color="warning">Verifying connection...</Text>}
        {error && <Text color="error">{error}</Text>}
        {notice && <Text dimColor>{notice}</Text>}
        <Text dimColor>
          {status === 'editing'
            ? 'Enter to confirm · Esc to cancel'
            : status === 'saving'
              ? 'Please wait...'
              : 'Esc to cancel'}
        </Text>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  return (
    <LoginForm
      onDone={message => {
        context.onChangeAPIKey()
        onDone(message)
      }}
      onCancel={() => onDone('Login cancelled')}
    />
  )
}
