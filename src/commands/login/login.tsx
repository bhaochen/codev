import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { Pane } from '../../components/design-system/Pane.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
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
 * Two-phase flow:
 *   LIST  — show endpoints, ↑↓ navigate, Enter edits, a adds, d deletes
 *   EDIT  — fill baseUrl → apiKey → modelName, each Enter advances,
 *           final Enter saves and returns to LIST with new active
 */
function LoginScreen({
  onDone,
}: {
  onDone: (message: string) => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [endpoints, setEndpoints] = React.useState<EndpointItem[]>([])
  // 'list' or 'edit-{id}'
  const [phase, setPhase] = React.useState<'list' | string>('list')
  const [cursor, setCursor] = React.useState(0)
  const [formIndex, setFormIndex] = React.useState(0)
  const [formValues, setFormValues] = React.useState<Record<FieldKey, string>>({
    baseUrl: '', apiKey: '', modelName: '',
  })
  const [formCursorOffset, setFormCursorOffset] = React.useState(0)
  const [formStatus, setFormStatus] = React.useState<'editing' | 'saving' | 'error'>('editing')
  const [formNotice, setFormNotice] = React.useState('')
  const [formError, setFormError] = React.useState('')

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

  // Sync cursor to active endpoint on mount
  React.useEffect(() => {
    const activeIdx = endpoints.findIndex(e => e.active)
    if (activeIdx >= 0 && cursor !== activeIdx) setCursor(activeIdx)
  }, [endpoints])

  // ── LIST SCREEN ─────────────────────────────────────────────────────────
  // Use Pane (no built-in confirm:yes) so Enter reaches our useInput handler
  useKeybinding('confirm:no', () => onDone('Login cancelled'), { context: 'Confirmation' })
  useInput(
    (input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean }) => {
      if (phase !== 'list') return
      if (key.upArrow && cursor > 0) setCursor(c => c - 1)
      else if (key.downArrow && cursor < endpoints.length - 1) setCursor(c => c + 1)
      else if (key.return) {
        // Enter: edit selected or add if empty
        if (endpoints[cursor]) {
          startEdit(endpoints[cursor])
        } else {
          // No endpoints — go straight to add form
          setFormValues({ baseUrl: '', apiKey: '', modelName: '' })
          setFormIndex(0)
          setFormStatus('editing')
          setPhase('edit-new')
        }
      } else if (input === 'a') {
        setFormValues({ baseUrl: '', apiKey: '', modelName: '' })
        setFormIndex(0)
        setFormStatus('editing')
        setPhase('edit-new')
      } else if (input === 'd' && endpoints[cursor]) {
        void removeCustomEndpoint(endpoints[cursor].id).then(refreshEndpoints)
      }
    },
    { isActive: phase === 'list' },
  )

  const startEdit = (ep: EndpointItem) => {
    setFormValues({ baseUrl: ep.baseUrl, apiKey: ep.apiKey ?? '', modelName: ep.modelName ?? '' })
    setFormIndex(0)
    setFormStatus('editing')
    setPhase(`edit-${ep.id}`)
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
      refreshEndpoints()
      setPhase('list')
      setFormStatus('editing')
      setFormValues({ baseUrl: '', apiKey: '', modelName: '' })
      setFormIndex(0)
    } catch (saveError) {
      setFormStatus('error')
      setFormError(saveError instanceof Error ? saveError.message : String(saveError))
    }
  }

  const isEditing = phase.startsWith('edit-')
  const editingId = isEditing ? phase.slice(5) : null
  const editingEp = endpoints.find(e => e.id === editingId)

  // ── LIST VIEW (Pane — no built-in confirm:yes to avoid Enter interception) ──
  if (phase === 'list') {
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold dimColor>Custom Endpoints</Text>
          {endpoints.length === 0 ? (
            <Text dimColor>No endpoints configured. Press a to add one.</Text>
          ) : (
            endpoints.map((ep, i) => (
              <Box key={ep.id} flexDirection="column">
                <Text color={ep.active ? 'green' : i === cursor ? 'white' : 'gray'}>
                  {ep.active ? '● ' : i === cursor ? '» ' : '  '}
                  {ep.baseUrl}
                  {ep.modelName ? `  model: ${ep.modelName}` : ''}
                </Text>
                {ep.apiKey && <Text dimColor indent={2}>key: {'*'.repeat(ep.apiKey.length)}</Text>}
              </Box>
            ))
          )}
          <Box flexDirection="row" gap={1}>
            <Text color="cyan">↑↓</Text>
            <Text dimColor>nav  </Text>
            <Text color="cyan">Enter</Text>
            <Text dimColor>edit  </Text>
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

  // ── EDIT FORM (Dialog with isCancelActive=false so Enter reaches TextInput) ──
  const isAdding = phase === 'edit-new'

  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold dimColor>
          {isAdding ? 'Add Endpoint' : `Edit: ${editingEp?.baseUrl ?? ''}`}
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
                onExit={() => { setPhase('list'); setFormStatus('editing') }}
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
    </Pane>
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
