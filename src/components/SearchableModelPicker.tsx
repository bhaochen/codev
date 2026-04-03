import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js'
import { FAST_MODE_MODEL_DISPLAY, isFastModeAvailable, isFastModeCooldown, isFastModeEnabled } from 'src/utils/fastMode.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { convertEffortValueToLevel, type EffortLevel, getDefaultEffortForModel, modelSupportsEffort, modelSupportsMaxEffort, resolvePickerEffortPersistence, toPersistableEffort } from '../utils/effort.js'
import { getDefaultMainLoopModel, type ModelSetting, modelDisplayString, parseUserSpecifiedModel } from '../utils/model/model.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import { effortLevelToSymbol } from './EffortIndicator.js'
import { FuzzyPicker } from './design-system/FuzzyPicker.js'
import capitalize from 'lodash-es/capitalize.js'

export type Props = {
  initial: string | null
  sessionModel?: ModelSetting
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  showFastModeNotice?: boolean
  headerText?: string
  skipSettingsWrite?: boolean
}

const NO_PREFERENCE = '__NO_PREFERENCE__'

export function SearchableModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
}: Props) {
  const setAppState = useSetAppState()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const initialValue = initial === null ? NO_PREFERENCE : initial
  const [focusedModel, setFocusedModel] = useState<string | undefined>(initialValue)

  const isFastMode = useAppState(s => isFastModeEnabled() ? s.fastMode : false)
  const authVersion = useAppState(s => s.authVersion)
  const [hasToggledEffort, setHasToggledEffort] = useState(false)
  const effortValue = useAppState(s => s.effortValue)
  const [effort, setEffort] = useState<EffortLevel | undefined>(
    effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined
  )

  const [searchQuery, setSearchQuery] = useState('')

  const modelOptions = React.useMemo(() => {
  try {
    return getModelOptions(isFastMode ?? false)
  } catch (error) {
    console.error('Error getting model options:', error)
    return []
  }
}, [isFastMode, authVersion])

  // Filter options based on search query
  const filteredOptions = React.useMemo(() => {
    if (!Array.isArray(modelOptions)) {
      return []
    }
    if (!searchQuery.trim()) {
      return modelOptions
    }
    const query = searchQuery.toLowerCase()
    return modelOptions.filter(opt => {
      const label = typeof opt.label === 'string' ? opt.label.toLowerCase() : ''
      const description = typeof opt.description === 'string' ? opt.description.toLowerCase() : ''
      const value = typeof opt.value === 'string' ? opt.value.toLowerCase() : ''
      return label.includes(query) || description.includes(query) || value.includes(query)
    })
  }, [modelOptions, searchQuery])

  // Add initial model if not in filtered options
  const optionsWithInitial = React.useMemo(() => {
    if (!Array.isArray(filteredOptions)) {
      return []
    }
    if (initial !== null && !filteredOptions.some(opt => opt.value === initial)) {
      try {
        const displayModel = modelDisplayString(initial)
        const customOption = {
          value: initial,
          label: displayModel,
          description: 'Current model',
        }
        return [...filteredOptions, customOption]
      } catch (error) {
        console.error('Error displaying initial model:', error)
        return filteredOptions
      }
    }
    return filteredOptions
  }, [filteredOptions, initial])

  const initialFocusValue = Array.isArray(optionsWithInitial) && optionsWithInitial.some(opt => opt.value === initialValue)
    ? initialValue
    : (Array.isArray(optionsWithInitial) && optionsWithInitial[0]?.value) ?? undefined

  // Helper functions
  function resolveOptionModel(value?: string): string | undefined {
    if (!value) return undefined
    return value === NO_PREFERENCE ? getDefaultMainLoopModel() : parseUserSpecifiedModel(value)
  }

  function getDefaultEffortLevelForOption(value?: string): EffortLevel {
    const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel()
    const defaultValue = getDefaultEffortForModel(resolved)
    return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'high'
  }

  function cycleEffortLevel(current: EffortLevel, direction: 'left' | 'right', includeMax: boolean): EffortLevel {
    const levels: EffortLevel[] = includeMax ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high']
    const idx = levels.indexOf(current)
    const currentIndex = idx !== -1 ? idx : levels.indexOf('high')
    if (direction === 'right') {
      return levels[(currentIndex + 1) % levels.length]!
    } else {
      return levels[(currentIndex - 1 + levels.length) % levels.length]!
    }
  }

  // Handle effort cycling
  const handleCycleEffort = useCallback((direction: 'left' | 'right') => {
    const resolvedModel = resolveOptionModel(focusedModel)
    if (!resolvedModel || !modelSupportsEffort(resolvedModel)) {
      return
    }
    const includeMax = modelSupportsMaxEffort(resolvedModel)
    setEffort(prev => cycleEffortLevel(prev ?? getDefaultEffortLevelForOption(focusedModel), direction, includeMax))
    setHasToggledEffort(true)
  }, [focusedModel])

  useKeybindings({
    'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
    'modelPicker:increaseEffort': () => handleCycleEffort('right'),
  }, { context: 'ModelPicker' })

  // Handle model selection
  const handleSelect = useCallback((option: { value: string | null; label: string; description: string }) => {
    logEvent('tengu_model_command_menu_effort', {
      effort: effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    if (!skipSettingsWrite) {
      const effortLevel = resolvePickerEffortPersistence(
        effort,
        getDefaultEffortLevelForOption(option.value ?? undefined),
        getSettingsForSource('userSettings')?.effortLevel,
        hasToggledEffort
      )
      const persistable = toPersistableEffort(effortLevel)
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', { effortLevel: persistable })
      }
      setAppState(prev => ({ ...prev, effortValue: effortLevel }))
    }

    const selectedModel = resolveOptionModel(option.value ?? undefined)
    const selectedEffort = hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel)
      ? effort
      : undefined

    if (option.value === null) {
      onSelect(null, selectedEffort)
      return
    }
    onSelect(option.value, selectedEffort)
  }, [effort, hasToggledEffort, onSelect, setAppState, skipSettingsWrite])

  // Render model item - only show label (description shown in preview)
  const renderItem = useCallback((option: { value: string | null; label: string; description: string }, isFocused: boolean) => {
    return <Text bold={isFocused}>{option.label}</Text>
  }, [])

  // Render preview with effort
  const renderPreview = useCallback((option: { value: string | null; label: string; description: string }) => {
    const resolvedModel = resolveOptionModel(option.value ?? undefined)
    const supportsEffort = resolvedModel ? modelSupportsEffort(resolvedModel) : false
    const supportsMax = resolvedModel ? modelSupportsMaxEffort(resolvedModel) : false
    const defaultEffort = getDefaultEffortLevelForOption(option.value ?? undefined)
    const displayEffort = effort === 'max' && !supportsMax ? 'high' : effort

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{option.description}</Text>
        {!supportsEffort ? (
          <Text dimColor>Effort not supported</Text>
        ) : (
          <>
            <Text dimColor>
              {capitalize(displayEffort)} effort
              {displayEffort === defaultEffort ? ' (default)' : ''}
            </Text>
            <Text color="subtle">← → to adjust</Text>
          </>
        )}
      </Box>
    )
  }, [effort])

  // Handle focus change
  const handleFocus = useCallback((option: { value: string | null; label: string; description: string } | undefined) => {
    setFocusedModel(option?.value ?? undefined)
    if (!hasToggledEffort && effortValue === undefined) {
      setEffort(getDefaultEffortLevelForOption(option?.value ?? undefined))
    }
  }, [hasToggledEffort, effortValue])

  // Handle query change
  const handleQueryChange = useCallback((query: string) => {
    setSearchQuery(query)
    setFocusedModel(undefined)
  }, [])

  // Fast mode notice
  let fastModeNotice: React.ReactNode = null
  if (isFastModeEnabled()) {
    if (showFastModeNotice) {
      fastModeNotice = (
        <Text dimColor>
          Fast mode is <Text bold>ON</Text> and available with{' '}
          {FAST_MODE_MODEL_DISPLAY} only (/fast). Switching to other models turn off fast mode.
        </Text>
      )
    } else if (isFastModeAvailable() && !isFastModeCooldown()) {
      fastModeNotice = (
        <Text dimColor>
          Use <Text bold>/fast</Text> to turn on Fast mode ({FAST_MODE_MODEL_DISPLAY} only).
        </Text>
      )
    }
  }

  // Match label
  const matchLabel = searchQuery.trim()
    ? `${optionsWithInitial.length} ${optionsWithInitial.length === 1 ? 'match' : 'matches'}`
    : undefined

  const content = (
    <FuzzyPicker
      title="Select model"
      placeholder="Search models..."
      items={optionsWithInitial}
      getKey={opt => opt.value ?? 'no-preference'}
      renderItem={renderItem}
      renderPreview={renderPreview}
      initialQuery={searchQuery}
      onQueryChange={handleQueryChange}
      onSelect={handleSelect}
      onFocus={handleFocus}
      onCancel={onCancel ?? (() => {
        logEvent('tengu_model_command_menu', {
          action: 'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      })}
      emptyMessage="No models match your search"
      matchLabel={matchLabel}
      selectAction="select"
      extraHints={fastModeNotice}
    />
  )

  return content
}