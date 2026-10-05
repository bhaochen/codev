import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { FuzzyPicker } from '../../components/design-system/FuzzyPicker.js'
import { Pane } from '../../components/design-system/Pane.js'
import { Select } from '../../components/CustomSelect/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { ModelOption } from '../../utils/model/modelOptions.js'
import {
  getEffortLevelDescription,
  getModelSupportedEfforts,
  type EffortLevel,
} from '../../utils/effort.js'
import type { APIProvider } from '../../utils/model/providers.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import type {
  FallbackProvider,
  FallbackTarget,
} from '../../utils/model/fallbackChain.js'

const PROVIDERS: Array<{
  value: FallbackProvider
  label: string
  description: string
}> = [
  {
    value: 'firstParty',
    label: 'Anthropic',
    description: 'Claude models using Anthropic credentials',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    description: 'GPT models using OpenAI credentials',
  },
  {
    value: 'opencode',
    label: 'OpenCode Zen',
    description: 'OpenCode models, including free models',
  },
  {
    value: 'nvidia',
    label: 'NVIDIA',
    description: 'Models available from your NVIDIA endpoint',
  },
]

type PanelAction =
  | { type: 'add' }
  | { type: 'manage' }
  | { type: 'selectTarget'; index: number }
  | { type: 'openEffort' }
  | { type: 'remove' }
  | { type: 'move'; direction: 'up' | 'down' }
  | { type: 'setEffort'; effort: FallbackTarget['effort'] }
  | { type: 'backToTarget' }
  | { type: 'toggle' }
  | { type: 'clear' }
  | { type: 'confirmClear' }
  | { type: 'cancelClear' }
  | { type: 'back' }
  | { type: 'done' }

function getChain(): FallbackTarget[] {
  return getSettingsForSource('userSettings')?.fallbackChain ?? []
}

function getEnabled(): boolean {
  return getSettingsForSource('userSettings')?.fallbackEnabled !== false
}

function saveChain(
  fallbackChain: FallbackTarget[],
  enable = false,
): string | undefined {
  const { error } = updateSettingsForSource('userSettings', {
    fallbackChain,
    ...(enable ? { fallbackEnabled: true } : {}),
  })
  return error?.message
}

async function getModels(provider: FallbackProvider): Promise<ModelOption[]> {
  if (provider === 'firstParty' || provider === 'anthropic') {
    return [
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', description: 'Most capable for complex tasks' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Balanced speed and capability' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fast and efficient' },
    ]
  }

  if (provider === 'openai') {
    const { fetchOpenAIModels } = await import('../../utils/model/openaiModels.js')
    const models = await fetchOpenAIModels()
    if (models.length > 0) return models
    return [
      { value: 'gpt-5.4', label: 'GPT-5.4', description: 'OpenAI general-purpose model' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Faster, lighter OpenAI model' },
    ]
  }

  if (provider === 'opencode') {
    const { fetchOpencodeModels, getCachedOpencodeModels } =
      await import('../../utils/model/opencodeModels.js')
    await fetchOpencodeModels()
    const models = getCachedOpencodeModels().map(model => ({
      value: model.id,
      label: model.name ?? model.id,
      description: model.isFree ? 'Free model' : model.id,
    }))
    if (models.length > 0) return models
    return [
      { value: 'big-pickle', label: 'Big Pickle', description: 'OpenCode Zen default model' },
      { value: 'gpt-5-nano', label: 'GPT-5 Nano', description: 'Fast OpenCode Zen model' },
    ]
  }

  const { fetchNvidiaModels, getCachedNvidiaModels } =
    await import('../../utils/model/nvidiaModels.js')
  await fetchNvidiaModels()
  const models = getCachedNvidiaModels().map(model => ({
    value: model.id,
    label: model.id,
    description: 'Available on your NVIDIA endpoint',
  }))
  return models.length > 0
    ? models
    : [
        {
          value: 'nvidia/llama-3.1-nemotron-70b-instruct',
          label: 'NVIDIA Nemotron 70B',
          description: 'NVIDIA default model',
        },
      ]
}

function getDirectActionResult(args: string): string | undefined {
  const [action, ...values] = args.trim().split(/\s+/).filter(Boolean)
  if (action === 'on' || action === 'off') {
    const { error } = updateSettingsForSource('userSettings', {
      fallbackEnabled: action === 'on',
    })
    return error
      ? `Failed to update fallback setting: ${error.message}`
      : `Fallback chain ${action === 'on' ? 'enabled' : 'disabled'}.`
  }
  if (action === 'clear') {
    const { error } = updateSettingsForSource('userSettings', {
      fallbackChain: [],
      fallbackEnabled: undefined,
    })
    return error ? `Failed to clear fallback chain: ${error.message}` : 'Cleared the fallback chain.'
  }
  if (action === 'remove') {
    const index = Number(values[0])
    const chain = getChain()
    if (!Number.isInteger(index) || index < 1 || index > chain.length) {
      return `Invalid target number. Choose 1-${chain.length || 1}.`
    }
    const error = saveChain(chain.filter((_, i) => i !== index - 1))
    return error ? `Failed to save fallback chain: ${error}` : `Removed fallback target ${index}.`
  }
  if (action === 'add') {
    const [provider, model, effort] = values
    const normalizedProvider = provider?.toLowerCase() === 'anthropic'
      ? 'firstparty'
      : provider?.toLowerCase()
    const supportedProvider = PROVIDERS.find(
      item => item.value.toLowerCase() === normalizedProvider,
    )
    const chain = getChain()
    if (!supportedProvider || !model) {
      return `Usage: /fallback add <${PROVIDERS.map(p => p.value).join('|')}> <model> [effort]`
    }
    if (chain.length >= 3) return 'The fallback chain supports at most 3 targets.'
    if (effort && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      return 'Invalid effort. Choose minimal, low, medium, high, xhigh, or max.'
    }
    const target: FallbackTarget = {
      provider: supportedProvider.value,
      model,
      ...(effort ? { effort: effort as FallbackTarget['effort'] } : {}),
    }
    const error = saveChain([...chain, target], true)
    return error ? `Failed to save fallback chain: ${error}` : `Added fallback target ${target.provider}/${target.model}.`
  }
  return undefined
}

function FallbackPanel({
  onDone,
  args,
}: {
  onDone: (result?: string) => void
  args: string
}): React.ReactNode {
  const [chain, setChain] = useState(getChain)
  const [enabled, setEnabled] = useState(getEnabled)
  const [stage, setStage] = useState<
    'menu' | 'provider' | 'models' | 'manage' | 'target' | 'effort' | 'confirmClear'
  >('menu')
  const [selectedTarget, setSelectedTarget] = useState<number>(0)
  const [provider, setProvider] = useState<FallbackProvider>('firstParty')
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelError, setModelError] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const [effortOptions, setEffortOptions] = useState<EffortLevel[]>([])
  const [effortLoading, setEffortLoading] = useState(false)
  const [effortError, setEffortError] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (args.trim()) {
      const result = getDirectActionResult(args)
      if (result) onDone(result)
      else {
        setStage('menu')
        setError('Unknown action. Run /fallback without arguments to open the panel.')
      }
    }
  }, [args, onDone])

  useEffect(() => {
    if (stage !== 'models') return
    let cancelled = false
    setModelError(undefined)
    void getModels(provider).then(
      result => {
        if (!cancelled) setModels(result)
      },
      cause => {
        if (!cancelled) {
          setModels([])
          setModelError(cause instanceof Error ? cause.message : String(cause))
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [provider, stage])

  useEffect(() => {
    if (stage !== 'effort') return
    const target = chain[selectedTarget]
    if (!target) {
      setEffortOptions([])
      setEffortError('The selected fallback target is no longer available.')
      return
    }

    let cancelled = false
    setEffortLoading(true)
    setEffortError(undefined)

    void (async () => {
      if (target.provider === 'opencode') {
        const { fetchOpencodeModels } = await import('../../utils/model/opencodeModels.js')
        await fetchOpencodeModels()
      } else if (target.provider === 'nvidia') {
        const { fetchNvidiaModels } = await import('../../utils/model/nvidiaModels.js')
        await fetchNvidiaModels()
      }

      const apiProvider: APIProvider =
        target.provider === 'anthropic' ? 'firstParty' : target.provider
      const supported = getModelSupportedEfforts(target.model, apiProvider)
      if (!cancelled) setEffortOptions(supported)
    })().catch(cause => {
      if (!cancelled) {
        setEffortOptions([])
        setEffortError(cause instanceof Error ? cause.message : String(cause))
      }
    }).finally(() => {
      if (!cancelled) setEffortLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [chain, selectedTarget, stage])

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return models
    return models.filter(model =>
      `${model.label} ${model.value} ${model.description}`.toLowerCase().includes(query),
    )
  }, [models, search])

  function finishAction(action: PanelAction): void {
    setError(undefined)
    if (action.type === 'done') {
      onDone('Fallback settings saved.')
      return
    }
    if (action.type === 'add') {
      if (chain.length >= 3) {
        setError('The fallback chain supports at most 3 targets.')
        return
      }
      setStage('provider')
      return
    }
    if (action.type === 'manage') {
      setStage('manage')
      return
    }
    if (action.type === 'selectTarget') {
      setSelectedTarget(action.index)
      setStage('target')
      return
    }
    if (action.type === 'openEffort') {
      setStage('effort')
      return
    }
    if (action.type === 'back') {
      setStage(stage === 'target' ? 'manage' : 'menu')
      return
    }
    if (action.type === 'backToTarget') {
      setStage('target')
      return
    }
    if (action.type === 'confirmClear') {
      setStage('confirmClear')
      return
    }
    if (action.type === 'cancelClear') {
      setStage('menu')
      return
    }
    if (action.type === 'remove') {
      const next = chain.filter((_, index) => index !== selectedTarget)
      const message = saveChain(next)
      if (message) {
        setError(message)
        return
      }
      setChain(next)
      setStage('menu')
      return
    }
    if (action.type === 'setEffort') {
      const target = chain[selectedTarget]
      if (!target) return
      const next = [...chain]
      if (action.effort) {
        next[selectedTarget] = { ...target, effort: action.effort }
      } else {
        const { effort: _effort, ...withoutEffort } = target
        next[selectedTarget] = withoutEffort
      }
      const message = saveChain(next)
      if (message) {
        setError(message)
        return
      }
      setChain(next)
      setStage('target')
      return
    }
    if (action.type === 'move') {
      const next = [...chain]
      const to = selectedTarget + (action.direction === 'up' ? -1 : 1)
      if (selectedTarget < 0 || selectedTarget >= next.length || to < 0 || to >= next.length) {
        return
      }
      const currentTarget = next[selectedTarget]
      const adjacentTarget = next[to]
      if (!currentTarget || !adjacentTarget) return
      next[selectedTarget] = adjacentTarget
      next[to] = currentTarget
      const message = saveChain(next)
      if (message) {
        setError(message)
        return
      }
      setChain(next)
      setSelectedTarget(to)
      setStage('manage')
      return
    }
    if (action.type === 'clear') {
      const { error: saveError } = updateSettingsForSource('userSettings', {
        fallbackChain: [],
        fallbackEnabled: undefined,
      })
      if (saveError) {
        setError(saveError.message)
        return
      }
      setChain([])
      setEnabled(true)
      setStage('menu')
      return
    }
    const nextEnabled = !enabled
    const { error: saveError } = updateSettingsForSource('userSettings', {
      fallbackEnabled: nextEnabled,
    })
    if (saveError) {
      setError(saveError.message)
      return
    }
    setEnabled(nextEnabled)
  }

  function addModel(model: ModelOption): void {
    const target: FallbackTarget = { provider, model: String(model.value) }
    const next = [...chain, target]
    const message = saveChain(next, true)
    if (message) {
      setError(message)
      setStage('menu')
      return
    }
    setChain(next)
    setStage('menu')
    setSearch('')
  }

  if (stage === 'provider') {
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold>Add a fallback provider</Text>
          <Text dimColor>Choose a provider, then pick one of its available models.</Text>
          <Select
            options={[
              ...PROVIDERS.map(item => ({
                label: item.label,
                value: item.value,
                description: item.description,
              })),
              { label: 'Back', value: 'back' as const },
            ]}
            onChange={value => {
              if (value === 'back') {
                setStage('menu')
              } else {
                setProvider(value)
                setSearch('')
                setStage('models')
              }
            }}
            onCancel={() => setStage('menu')}
            visibleOptionCount={5}
          />
        </Box>
      </Pane>
    )
  }

  if (stage === 'manage') {
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold>Manage fallback targets</Text>
          <Text dimColor>Select a target to change its position or remove it.</Text>
          <Select
            options={[
              {
                label: 'Add provider and model…',
                value: { type: 'add' } as PanelAction,
                description: chain.length < 3 ? 'Choose a provider and model' : 'Maximum of 3 targets reached',
                disabled: chain.length >= 3,
              },
              ...chain.map((target, index) => ({
                label: `${index + 1}. ${target.provider}/${target.model}`,
                value: { type: 'selectTarget', index } as PanelAction,
              })),
              { label: 'Back', value: { type: 'back' } as PanelAction },
            ]}
            onChange={finishAction}
            onCancel={() => setStage('menu')}
            visibleOptionCount={5}
          />
        </Box>
      </Pane>
    )
  }

  if (stage === 'target') {
    const target = chain[selectedTarget]
    if (!target) {
      return (
        <Pane color="permission">
          <Box flexDirection="column" gap={1}>
            <Text bold>Fallback target unavailable</Text>
            <Text dimColor>The chain changed. Return to the target list.</Text>
            <Select
              options={[{ label: 'Back to targets', value: { type: 'back' } as PanelAction }]}
              onChange={finishAction}
              onCancel={() => setStage('manage')}
              visibleOptionCount={1}
            />
          </Box>
        </Pane>
      )
    }
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold>{selectedTarget + 1}. {target.provider}/{target.model}</Text>
          <Text dimColor>
            Current effort: {target.effort ?? 'Auto'} · fallback order determines which target is tried first.
          </Text>
          <Select
            options={[
              {
                label: `Effort: ${target.effort ?? 'Auto'}…`,
                value: { type: 'openEffort' } as PanelAction,
                description: 'Choose the reasoning effort for this target',
              },
              ...(selectedTarget > 0
                ? [{ label: 'Move earlier', value: { type: 'move', direction: 'up' } as PanelAction }]
                : []),
              ...(selectedTarget < chain.length - 1
                ? [{ label: 'Move later', value: { type: 'move', direction: 'down' } as PanelAction }]
                : []),
              { label: 'Remove target', value: { type: 'remove' } as PanelAction },
              { label: 'Back', value: { type: 'back' } as PanelAction },
            ]}
            onChange={finishAction}
            onCancel={() => setStage('manage')}
            visibleOptionCount={4}
          />
        </Box>
      </Pane>
    )
  }

  if (stage === 'effort') {
    const target = chain[selectedTarget]
    if (!target) {
      return (
        <Pane color="permission">
          <Box flexDirection="column" gap={1}>
            <Text bold>Fallback target unavailable</Text>
            <Select
              options={[{ label: 'Back to targets', value: { type: 'back' } as PanelAction }]}
              onChange={() => setStage('manage')}
              onCancel={() => setStage('manage')}
              visibleOptionCount={1}
            />
          </Box>
        </Pane>
      )
    }
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold>Effort · {target.provider}/{target.model}</Text>
          <Text dimColor>
            Options follow /effort model support and provider catalog data. Auto uses the session default.
          </Text>
          {effortLoading ? (
            <>
              <Text dimColor>Loading supported effort levels…</Text>
              <Select
                options={[{ label: 'Back', value: { type: 'backToTarget' } as PanelAction }]}
                onChange={finishAction}
                onCancel={() => setStage('target')}
                visibleOptionCount={1}
              />
            </>
          ) : effortError ? (
            <>
              <Text color="error">Could not load effort levels: {effortError}</Text>
              <Select
                options={[{ label: 'Back', value: { type: 'backToTarget' } as PanelAction }]}
                onChange={finishAction}
                onCancel={() => setStage('target')}
                visibleOptionCount={1}
              />
            </>
          ) : (
            <Select
              options={[
                {
                  label: `Auto${target.effort === undefined ? ' · current' : ''}`,
                  value: { type: 'setEffort', effort: undefined } as PanelAction,
                  description: 'Use the session default effort',
                },
                ...effortOptions.map(effort => ({
                  label: `${effort[0]!.toUpperCase()}${effort.slice(1)}${target.effort === effort ? ' · current' : ''}`,
                  value: { type: 'setEffort', effort } as PanelAction,
                  description: getEffortLevelDescription(effort),
                })),
              ]}
              onChange={finishAction}
              onCancel={() => setStage('target')}
              visibleOptionCount={7}
            />
          )}
        </Box>
      </Pane>
    )
  }

  if (stage === 'confirmClear') {
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold>Clear fallback chain?</Text>
          <Text dimColor>This removes all {chain.length} configured targets.</Text>
          <Select
            options={[
              { label: 'Keep targets', value: { type: 'cancelClear' } as PanelAction },
              { label: 'Clear all targets', value: { type: 'clear' } as PanelAction },
            ]}
            onChange={finishAction}
            onCancel={() => setStage('menu')}
            visibleOptionCount={2}
          />
        </Box>
      </Pane>
    )
  }

  if (stage === 'models') {
    return (
      <FuzzyPicker
        title={`Choose a ${PROVIDERS.find(item => item.value === provider)?.label} model`}
        placeholder="Search models…"
        items={filteredModels}
        getKey={model => String(model.value)}
        renderItem={model => (
          <Text>
            {model.label}
            <Text dimColor>  {String(model.value)}</Text>
          </Text>
        )}
        onQueryChange={setSearch}
        onSelect={addModel}
        onCancel={() => setStage('provider')}
        emptyMessage={
          modelError
            ? `Could not load models: ${modelError}`
            : 'Loading models…'
        }
        visibleCount={8}
      />
    )
  }

  const options = [
    {
      label: enabled ? 'Disable automatic fallback' : 'Enable automatic fallback',
      value: { type: 'toggle' } as PanelAction,
      description: enabled ? 'Currently on' : 'Currently off',
    },
    ...(chain.length > 0
      ? [
          {
            label: 'Manage fallback targets…',
            value: { type: 'manage' } as PanelAction,
            description: 'Reorder or remove an individual target',
          },
          {
            label: 'Clear all targets…',
            value: { type: 'confirmClear' } as PanelAction,
            description: 'Remove every configured target',
          },
        ]
      : []),
    {
      label: 'Done',
      value: { type: 'done' } as PanelAction,
      description: 'Save and close',
    },
  ]

  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold>Fallback chain · {enabled ? 'On' : 'Off'}</Text>
        {chain.length === 0 ? (
          <Text dimColor>No fallback models configured yet.</Text>
        ) : (
          <Box flexDirection="column">
            {chain.map((target, index) => (
              <Text key={`${target.provider}/${target.model}`}>
                {index + 1}. {target.provider}/{target.model}
                {target.effort ? ` · ${target.effort} effort` : ''}
              </Text>
            ))}
          </Box>
        )}
        <Text dimColor>
          On eligible errors, Codev tries targets in order. Prompts are sent to the selected provider.
        </Text>
        {error ? <Text color="error">{error}</Text> : null}
        <Select
          options={options}
          onChange={finishAction}
          onCancel={() => onDone()}
          visibleOptionCount={Math.min(7, options.length)}
        />
      </Box>
    </Pane>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => (
  <FallbackPanel onDone={onDone} args={args.trim()} />
)
