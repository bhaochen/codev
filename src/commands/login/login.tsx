import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  getCustomEndpoints,
  clearStoredProviderCache,
} from '../../utils/model/providers.js'
import {
  saveCustomApiConfig,
  removeCustomEndpoint,
  setActiveCustomEndpointIndex,
} from '../../utils/auth.js'

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

/**
 * Single component that manages both the endpoint list and the add-form.
 * Uses Dialog (which handles its own confirm:no / Esc keybinding) with
 * isCancelActive toggled when the form is active, so the form's TextInput
 * gets focus while the list screen keeps its own useInput for arrows/Enter.
 */
function LoginScreen({
  onDone,
}: {
  onDone: (message: string) => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [endpoints, setEndpoints] = React.useState<EndpointItem[]>([])
  const [phase, setPhase] = React.useState<'list' | 'add'>('list')
  const [formIndex, setFormIndex] = React.useState(0)
  const [formValues, setFormValues] = React.useState<Record<FieldKey, string>>({
    baseUrl: '', apiKey: '', modelName: '',
  })
  const [formCursorOffset, setFormCursorOffset] = React.useState(0)
  const [formStatus, setFormStatus] = React.useState<'editing' | 'saving' | 'error'>('editing')
  const [formNotice, setFormNotice] = React.useState('')
  const [formError, setFormError] = React.useState('')
  // Cursor position in the list (for ↑↓ navigation)
  const [cursor, setCursor] = React.useState(0)

  // Load endpoints from config
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

  // Sync cursor to active endpoint on mount / when endpoints change
  React.useEffect(() => {
    const activeIdx = endpoints.findIndex(e => e.active)
    if (activeIdx >= 0 && cursor !== activeIdx) setCursor(activeIdx)
  }, [endpoints])

  // List screen key bindings (↑↓ Enter)
  useInput(
    (_input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean }) => {
      if (phase !== 'list') return
      if (key.upArrow && cursor > 0) setCursor(c => c - 1)
      else if (key.downArrow && cursor < endpoints.length - 1) setCursor(c => c + 1)
      else if (key.return && endpoints[cursor]) {
        const id = endpoints[cursor].id
        const idx = endpoints.findIndex(e => e.id === id)
        if (idx >= 0) {
          void setActiveCustomEndpointIndex(idx).then(refreshEndpoints)
        }
      }
    },
    { isActive: phase === 'list' },
  )

  const handleSubmit = async (vals: Record<FieldKey, string>) => {
    const baseUrl = vals.baseUrl.trim()
    const apiKey = vals.apiKey.trim()
    const modelName = vals.modelName.trim()

    if (!baseUrl) {
      setFormStatus('error')
      setFormError('API Base URL is required')
      setFormIndex(0)
      return
    }

    setFormStatus('saving')
    setFormError('')
    setFormNotice('')

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
      setFormStatus('error')
      setFormError(saveError instanceof Error ? saveError.message : String(saveError))
    }
  }

  const handleFieldSubmit = (value: string) => {
    const next = { ...formValues, [FIELDS[formIndex].key]: value }
    setFormValues(next)
    if (formIndex < FIELDS.length - 1) {
      setFormIndex(formIndex + 1)
      setFormCursorOffset(0)
    } else {
      void handleSubmit(next)
    }
  }

  const handleAdd = () => setPhase('add')
  const handleBack = () => setPhase('list')
  const handleDelete = async (id: string) => {
    await removeCustomEndpoint(id)
    refreshEndpoints()
  }

  if (phase === 'list') {
    return (
      <Dialog title="Configure Custom Endpoints" onCancel={() => onDone('Login cancelled')}>
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
      </Dialog>
    )
  }

  // ── Add endpoint form ────────────────────────────────────────────────────
  const field = FIELDS[formIndex]

  return (
    <Dialog
      title="Add Endpoint"
      onCancel={handleBack}
      isCancelActive={formStatus === 'editing'}
    >
      <Box flexDirection="column" gap={1}>
        <Text bold>OpenAI-compatible endpoint</Text>
        <Text dimColor>
          Any OpenAI Chat Completions API (vLLM, llama.cpp, 9router, OpenRouter, …).
        </Text>
        {FIELDS.map((item, itemIndex) => (
          <Box key={item.key} flexDirection="column">
            <Text dimColor={itemIndex !== formIndex}>{item.label}</Text>
            {itemIndex === formIndex && formStatus === 'editing' ? (
              <TextInput
                value={formValues[item.key]}
                onChange={v => setFormValues(prev => ({ ...prev, [item.key]: v }))}
                onChangeCursorOffset={setFormCursorOffset}
                onSubmit={handleFieldSubmit}
                onExit={handleBack}
                placeholder={item.placeholder}
                mask={item.mask}
                columns={columns}
                cursorOffset={formCursorOffset}
                showCursor
                focus
              />
            ) : (
              <Text>
                {item.mask && formValues[item.key]
                  ? item.mask.repeat(formValues[item.key].length)
                  : formValues[item.key] || '(not set)'}
              </Text>
            )}
          </Box>
        ))}
        {formStatus === 'saving' && <Text color="warning">Verifying connection...</Text>}
        {formError && <Text color="error">{formError}</Text>}
        {formNotice && <Text dimColor>{formNotice}</Text>}
        <Text dimColor>
          {formStatus === 'editing'
            ? 'Enter to confirm · Esc to cancel'
            : formStatus === 'saving'
              ? 'Please wait...'
              : 'Esc to cancel'}
        </Text>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  return (
    <LoginScreen
      onDone={message => {
        context.onChangeAPIKey()
        onDone(message)
      }}
    />
  )
}
