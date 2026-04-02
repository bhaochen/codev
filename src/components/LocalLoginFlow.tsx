import * as React from 'react'
import { useState } from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { saveLocalModelConfig } from '../utils/auth.js'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'
import Dialog from './design-system/Dialog.js'

interface Props {
  onDone: LocalJSXCommandOnDone
  startingMessage?: string
}

export function LocalLoginFlow({ onDone, startingMessage }: Props) {
  const [url, setUrl] = useState('')
  const [modelName, setModelName] = useState<string>('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const defaultUrl = 'http://127.0.0.1:8001'

  // 分析 URL 提取模型名
  const analyzeUrl = (inputUrl: string) => {
    setIsAnalyzing(true)
    try {
      const urlObj = new URL(inputUrl)
      // 从 URL 路径中提取模型名，例如 http://127.0.0.1:8001/v1/models
      const pathParts = urlObj.pathname.split('/').filter(Boolean)
      const extractedModel = pathParts[pathParts.length - 1] || 'default'
      setModelName(extractedModel)
    } catch {
      setModelName('')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const handleUrlChange = (value: string) => {
    setUrl(value)
    analyzeUrl(value)
  }

  const handleSubmit = async () => {
    const finalUrl = url.trim() || defaultUrl
    const finalModel = modelName || 'default'
    
    try {
      // 保存本地模型配置
      await saveLocalModelConfig(finalUrl, finalModel)
      onDone(true)
    } catch (error) {
      console.error('Failed to save local model config:', error)
      onDone(false)
    }
  }

  const handleCancel = () => {
    onDone(false)
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold={true}>
        {startingMessage ?? 'Configure local model server.'}
      </Text>
      
      <Box flexDirection="column" gap={1}>
        <Text>Enter local model server URL:</Text>
        <TextInput
          value={url}
          onChange={handleUrlChange}
          onSubmit={handleSubmit}
          onExit={handleCancel}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          columns={72}
          placeholder={defaultUrl}
          focus={true}
        />
      </Box>

      {modelName && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor={true}>
            Detected model: <Text bold={true}>{modelName}</Text>
          </Text>
        </Box>
      )}

      <Box flexDirection="row" gap={2} marginTop={1}>
        <Text color="subtle">Press Enter to confirm</Text>
        <Text color="subtle">·</Text>
        <Text color="subtle">Esc to cancel</Text>
      </Box>
    </Box>
  )
}