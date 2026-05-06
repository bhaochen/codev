import * as React from 'react'
import { useState, useEffect } from 'react'
import { saveOpenCodeApiKey, getOpenCodeApiKey, getOpenCodeModelName } from '../utils/auth.js'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/select.js'

type OpenCodeLoginFlowProps = {
  onDone: () => void
  startingMessage?: string
}

type LoginMode = 'menu' | 'free_models' | 'api_key'

const FREE_MODELS = [
  { label: 'Big Pickle (推荐)', value: 'big-pickle', description: '旗舰模型，限时免费，适合复杂任务' },
  { label: 'GPT 5 Nano', value: 'gpt-5-nano', description: '永久免费，轻量快速，隐私安全' },
  { label: 'MiniMax M2.5 Free', value: 'minimax-m2.5-free', description: '限时免费，编码推理强' },
  { label: 'GLM 4.7 Free', value: 'glm-4.7-free', description: '限时免费，智谱开源模型' },
  { label: 'Kimi K2.5 Free', value: 'kimi-k2.5-free', description: '限时免费，月之暗面模型' },
  { label: 'Nemotron 3 Super Free', value: 'nemotron-3-super-free', description: '限时免费，NVIDIA 模型，100万上下文' },
]

export function OpenCodeLoginFlow({
  onDone,
  startingMessage,
}: OpenCodeLoginFlowProps): React.ReactNode {
  const [mode, setMode] = useState<LoginMode>('menu')
  const [isBusy, setIsBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [selectedModel, setSelectedModel] = useState('big-pickle')
  const [existingApiKey, setExistingApiKey] = useState<string | null>(null)
  const [existingModelName, setExistingModelName] = useState<string | null>(null)

  useEffect(() => {
    const key = getOpenCodeApiKey()
    if (key) {
      setExistingApiKey(key)
    }
    const model = getOpenCodeModelName()
    if (model) {
      setExistingModelName(model)
      setSelectedModel(model)
    }
  }, [])

  const menuOptions = [
    {
      label: (
        <Text>
          Use free models{' '}
          <Text dimColor={true}>No API key required, select a model</Text>
          {'\n'}
        </Text>
      ),
      value: 'free_models',
    },
    {
      label: (
        <Text>
          Paste OpenCode Zen API key{' '}
          <Text dimColor={true}>Access paid models, pay-as-you-go</Text>
          {'\n'}
        </Text>
      ),
      value: 'api_key',
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

    if (value === 'free_models') {
      setMode('free_models')
      return
    }
  }

  async function handleFreeModelSelect(): Promise<void> {
    setIsBusy(true)
    setStatus(null)
    try {
      // 免费模型不需要 API Key，直接保存模型名称
      await saveOpenCodeApiKey('', selectedModel)
      onDone()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleSubmit(value?: string): Promise<void> {
    const trimmed = value?.trim() || ''
    const keyToSave = trimmed || existingApiKey

    if (!keyToSave) {
      return
    }

    setIsBusy(true)
    setStatus(null)
    try {
      await saveOpenCodeApiKey(keyToSave)
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
        <Text>Configuring OpenCode Zen for Better-Clawd...</Text>
        <Text dimColor={true}>
          OpenCode Zen provides free models with no API key required.
        </Text>
      </Box>
    )
  }

  if (mode === 'free_models') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold={true}>
          {startingMessage ?? 'Select a free model from OpenCode Zen.'}
        </Text>
        <Text dimColor={true}>
          Free models are limited-time offers except GPT 5 Nano (permanently free).
          {'\n'}
          No API key needed — just start coding!
        </Text>
        <Text>Select model:</Text>
        <Select
          options={FREE_MODELS.map(model => ({
            label: (
              <Text>
                {model.label}{' '}
                <Text dimColor={true}>{model.description}</Text>
                {'\n'}
              </Text>
            ),
            value: model.value,
          }))}
          onChange={value => {
            setSelectedModel(value)
            // 选择后直接提交
            void handleFreeModelSelect()
          }}
        />
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Text color="subtle">Select a model to continue</Text>
          <Text color="subtle">·</Text>
          <Text color="subtle">Esc to cancel</Text>
        </Box>
        {status ? <Text color="error">{status}</Text> : null}
        <Box marginTop={1}>
          <TextInput
            value=""
            onChange={() => {}}
            onSubmit={handleFreeModelSelect}
            onExit={() => setMode('menu')}
            cursorOffset={0}
            onChangeCursorOffset={() => {}}
            columns={72}
            focus={true}
            placeholder="Or press Enter to use selected model"
          />
        </Box>
      </Box>
    )
  }

  if (mode === 'api_key') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          OpenCode Zen API keys use pay-as-you-go billing.
          {'\n'}
          Sign up at opencode.ai/zen to get your key.
        </Text>
        <Box>
          <Text>Paste your OpenCode Zen API key:</Text>
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
            placeholder={existingApiKey || undefined}
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
          'Better-Clawd can use OpenCode Zen free models or with a standard OpenCode Zen API key.'}
      </Text>
      <Text dimColor={true}>
        OpenCode Zen provides free models out of the box — no API key required.
        {'\n'}
        Free models include Big Pickle, GPT 5 Nano, and more.
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
