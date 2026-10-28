import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { Pane } from '../../components/design-system/Pane.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getCustomEndpoints } from '../../utils/model/providers.js'
import {
  saveCustomApiConfig,
  removeCustomEndpoint,
  setActiveCustomEndpointIndex,
} from '../../utils/auth.js'
import { clearStoredProviderCache } from '../../utils/model/providers.js'

type FieldKey = 'baseUrl' | 'apiKey' | 'modelName'

const FIELDS: Array<{ key: FieldKey; label: string; placeholder: string; mask?: string }> = [
  { key: 'baseUrl', label: 'API Base URL', placeholder: 'http://localhost:8080/v1' },
  { key: 'apiKey', label: 'API Key (optional)', placeholder: 'press Enter to skip', mask: '*' },
  { key: 'modelName', label: 'Model (optional)', placeholder: 'press Enter to skip' },
]

async function verifyEndpoint(baseUrl: string, apiKey: string): Promise<void> {
  const url = new URL(baseUrl)
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(`${url.origin}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
}

type EndpointItem = { id: string; baseUrl: string; apiKey: string | null; modelName: string | null; active: boolean }

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint list screen
// ─────────────────────────────────────────────────────────────────────────────
function EndpointListScreen({
  endpoints,
  onSelect,
  onAdd,
  onDelete,
  onCancel,
}: {
  endpoints: EndpointItem[]
  onSelect: (id: string) => void
  onAdd: () => void
  onDelete: (id: string) => void
  onCancel: () => void
}): React.ReactNode {
  const [cursor, setCursor] = React.useState(0)
  const activeIdx = endpoints.findIndex(e => e.active)

  // Sync cursor to active endpoint on mount
  React.useEffect(() => {
    if (activeIdx >= 0 && cursor !== activeIdx) setCursor(activeIdx)
  }, []) // only on mount

  // Top-level useInput — must NOT be inside useEffect
  useInput(
    (_input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean }) => {
      if (key.upArrow && cursor > 0) setCursor(c => c - 1)
      else if (key.downArrow && cursor < endpoints.length - 1) setCursor(c => c + 1)
      else if (key.return) onSelect(endpoints[cursor]?.id)
    },
    { isActive: true },
  )

  // Top-level useKeybinding for ESC
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })

  return (
    <Pane>
      <Box flexDirection="column" gap={1}>
        <Text bold dimColor>OpenAI-compatible endpoints</Text>
        {endpoints.length === 0 ? (
          <Text dimColor>No endpoints configured.</Text>
        ) : (
          endpoints.map((ep, i) => (
            <Box key={ep.id} flexDirection="column">
              <Text color={ep.active ? 'green' : i === cursor ? 'white' : 'gray'}>
                {ep.active ? '▶ ' : i === cursor ? '► ' : '  '}
                {i + 1}. {ep.baseUrl}
                {ep.modelName ? `  model: ${ep.modelName}` : ''}
              </Text>
              {ep.apiKey && <Text dimColor indent={2}>key: {'*'.repeat(ep.apiKey.length)}</Text>}
            </Box>
          ))
        )}
        <Box flexDirection="row" gap={1}>
          <Text color="cyan">↑↓</Text>
          <Text dimColor>select  </Text>
          <Text color="cyan">Enter</Text>
          <Text dimColor>activate  </Text>
          <Text color="cyan">a</Text>
          <Text dimColor>add  </Text>
          <Text color="red">d</Text>
          <Text dimColor>delete  </Text>
          <Text color="cyan">Esc</Text>
          <Text dimColor>done</Text>
        </Box>
      </Box>
    </Pane>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Add endpoint form
// ─────────────────────────────────────────────────────────────────────────────
function LoginForm({
  onDone,
  onCancel,
}: {
  onDone: (message: string) => void
  onCancel: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [index, setIndex] = React.useState(0)
  const [values, setValues] = React.useState<Record<FieldKey, string>>({
    baseUrl: '', apiKey: '', modelName: '',
  })
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [status, setStatus] = React.useState<'editing' | 'saving' | 'error'>('editing')
  const [notice, setNotice] = React.useState('')
  const [error, setError] = React.useState('')

  const field = FIELDS[index]

  const submit = React.useCallback(
    async (vals: Record<FieldKey, string>) => {
      const baseUrl = vals.baseUrl.trim()
      const apiKey = vals.apiKey.trim()
      const modelName = vals.modelName.trim()

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
      } catch (err) {
        noticeText = `Saved without verification (${err instanceof Error ? err.message : 'unknown'})`
      }

      try {
        await saveCustomApiConfig(baseUrl, modelName, apiKey || undefined)
        clearStoredProviderCache()
        onDone(
          `Configured: ${baseUrl}${modelName ? ` (model: ${modelName})` : ''}${
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

  // ESC to cancel
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })

  return (
    <Pane>
      <Box flexDirection="column" gap={1}>
        <Text bold>OpenAI-compatible endpoint</Text>
        <Text dimColor>
          Any OpenAI Chat Completions API (vLLM, llama.cpp, 9router, OpenRouter, …).
        </Text>
        {FIELDS.map((item, itemIndex) => (
          <Box key={item.key} flexDirection="column">
            <Text dimColor={itemIndex !== index}>{item.label}</Text>
            {itemIndex === index && status === 'editing' ? (
              <TextInput
                value={values[item.key]}
                onChange={v => setValues(prev => ({ ...prev, [item.key]: v }))}
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
                  ? item.mask.repeat(values[item.key].length)
                  : values[item.key] || '(not set)'}
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
    </Pane>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Command entry point
// ─────────────────────────────────────────────────────────────────────────────
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const [phase, setPhase] = React.useState<'list' | 'add'>('list')
  const [endpoints, setEndpoints] = React.useState<EndpointItem[]>([])

  const refreshEndpoints = React.useCallback(() => {
    try {
      const eps = getCustomEndpoints()
      const cfg = (() => {
        try {
          const { getGlobalConfigSnapshot } = require('../../utils/config.js')
          return getGlobalConfigSnapshot()
        } catch { return {} }
      })()
      const activeIdx = cfg.currentCustomEndpointIndex ?? 0
      setEndpoints(eps.map((e, i) => ({
        id: e.id,
        baseUrl: e.baseUrl,
        apiKey: e.apiKey ?? null,
        modelName: e.modelName ?? null,
        active: i === activeIdx,
      })))
    } catch {}
  }, [])

  React.useEffect(() => {
    refreshEndpoints()
  }, [])

  const handleSelect = async (id: string) => {
    const idx = endpoints.findIndex(e => e.id === id)
    if (idx >= 0) {
      await setActiveCustomEndpointIndex(idx)
      refreshEndpoints()
    }
  }

  const handleDelete = async (id: string) => {
    await removeCustomEndpoint(id)
    refreshEndpoints()
  }

  const handleAddDone = (message: string) => {
    context.onChangeAPIKey()
    refreshEndpoints()
    onDone(message)
  }

  return phase === 'list' ? (
    <EndpointListScreen
      endpoints={endpoints}
      onSelect={handleSelect}
      onAdd={() => setPhase('add')}
      onDelete={handleDelete}
      onCancel={() => onDone('Login cancelled')}
    />
  ) : (
    <LoginForm
      onDone={handleAddDone}
      onCancel={() => setPhase('list')}
    />
  )
}
