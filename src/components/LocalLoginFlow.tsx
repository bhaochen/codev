import * as React from 'react'
import { useState, useEffect } from 'react'
import { saveLocalModelConfig, getLocalBaseUrl, getLocalModelName } from '../utils/auth.js'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'

interface Props {
  onDone: () => void
  startingMessage?: string
}

export function LocalLoginFlow({ onDone, startingMessage }: Props) {
  const [url, setUrl] = useState('')
  const [modelName, setModelName] = useState<string>('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [existingBaseUrl, setExistingBaseUrl] = useState<string | null>(null)
  const [existingModelName, setExistingModelName] = useState<string | null>(null)
  const defaultUrl = 'http://127.0.0.1:8001'

  useEffect(() => {
    const baseUrl = getLocalBaseUrl()
    const model = getLocalModelName()
    if (baseUrl) {
      setExistingBaseUrl(baseUrl)
      setUrl(baseUrl)
    }
    if (model) {
      setExistingModelName(model)
      setModelName(model)
    }
  }, [])

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
      onDone()
    } catch (error) {
      console.error('Failed to save local model config:', error)
      onDone()
    }
  }

  const handleCancel = () => {
    onDone()
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
          placeholder={existingBaseUrl || defaultUrl}
          focus={true}
        />
      </Box>

      {(modelName || existingModelName) && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor={true}>
            {modelName ? 
              `Detected model: <Text bold={true}>{modelName}</Text>` : 
              `Current model: <Text bold={true}>{existingModelName}</Text>`
            }
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