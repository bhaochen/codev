import * as React from 'react'
import { useState, useEffect, useRef } from 'react'
import { saveLocalModelConfig, getLocalBaseUrl, getLocalModelName } from '../utils/auth.js'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'

interface Props {
  onDone: () => void
  startingMessage?: string
}

interface ModelsResponse {
  models?: Array<{ name: string; model: string; type: string }>
  data?: Array<{ id: string; meta?: { n_ctx?: number; n_params?: number } }>
  object?: string
}

interface NativeModelsResponse {
  data?: Array<{
    id: string
    meta?: { n_ctx?: number; n_ctx_train?: number }
    status?: { args?: string[]; preset?: string }
  }>
}

const defaultUrl = 'http://127.0.0.1:8001'

export function LocalLoginFlow({ onDone, startingMessage }: Props) {
  const [url, setUrl] = useState('')
  const [modelName, setModelName] = useState<string>('')
  const [contextWindow, setContextWindow] = useState<number | null>(null)
  const [cursorOffset, setCursorOffset] = useState(0)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [existingBaseUrl, setExistingBaseUrl] = useState<string | null>(null)
  const [existingModelName, setExistingModelName] = useState<string | null>(null)
  const fetchAbortRef = useRef<AbortController | null>(null)
  const fetchPromiseRef = useRef<Promise<void> | null>(null)
  const fetchResolveRef = useRef<() => void>()

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

  const fetchModels = async (inputUrl: string): Promise<void> => {
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort()
    }
    const controller = new AbortController()
    fetchAbortRef.current = controller

    // Create a promise that resolves when fetch completes
    const fetchPromise = new Promise<void>((resolve) => {
      fetchResolveRef.current = resolve
    })
    fetchPromiseRef.current = fetchPromise

    setIsAnalyzing(true)
    setFetchError(null)
    try {
      const urlObj = new URL(inputUrl)
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`
      
      // Try OpenAI-compatible /v1/models first
      let detectedModel = ''
      let detectedContextWindow: number | null = null
      let fetchSucceeded = false

      try {
        const response = await fetch(`${baseUrl}/v1/models`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' }
        })

        if (response.ok) {
          const data = await response.json() as ModelsResponse
          
          // Extract model name from either format
          if (data.models && data.models.length > 0) {
            detectedModel = data.models[0].name
          } else if (data.data && data.data.length > 0) {
            detectedModel = data.data[0].id
          }
          
          // Extract context window from either format's meta
          if (data.data && data.data.length > 0 && data.data[0].meta?.n_ctx) {
            detectedContextWindow = data.data[0].meta.n_ctx
          } else if (data.models && data.models.length > 0 && (data.models[0] as any).meta?.n_ctx) {
            detectedContextWindow = (data.models[0] as any).meta.n_ctx
          }
          
          fetchSucceeded = true
        }
      } catch (e) {
        // /v1/models failed, will try native /models below
      }

      // If /v1/models failed, try native llama.cpp /models endpoint
      if (!fetchSucceeded && !controller.signal.aborted) {
        try {
          const nativeUrl = baseUrl.replace(/\/v1$/, '')
          const response = await fetch(`${nativeUrl}/models`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' }
          })

          if (response.ok) {
            const data = await response.json() as NativeModelsResponse
            
            if (data.data && data.data.length > 0) {
              detectedModel = data.data[0].id
              let configuredCtx: number | undefined
              if (data.data[0].status?.args) {
                const args = data.data[0].status.args.join(' ')
                const m = args.match(/--ctx-size\s+(\d+)/)
                if (m) configuredCtx = Number(m[1])
              }
              detectedContextWindow = data.data[0].meta?.n_ctx ?? configuredCtx ?? data.data[0].meta?.n_ctx_train ?? null
            }
            fetchSucceeded = true
          }
        } catch (e) {
          // Native /models also failed
        }
      }

      if (!controller.signal.aborted) {
        if (fetchSucceeded && detectedModel) {
          setModelName(detectedModel)
          if (detectedContextWindow) {
            setContextWindow(detectedContextWindow)
          }
          setFetchError(null)
        } else {
          setModelName('')
          setContextWindow(null)
          setFetchError('Could not detect model. Check URL and server.')
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        setModelName('')
        setContextWindow(null)
        setFetchError('Connection failed. Check URL and network.')
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsAnalyzing(false)
        fetchResolveRef.current?.()
      }
    }
  }

  const handleUrlChange = (value: string) => {
    setUrl(value)
    fetchModels(value)
  }

  const handleSubmit = async () => {
    const finalUrl = url.trim() || defaultUrl
    
    // Wait for any in-flight fetch to complete before saving
    if (fetchPromiseRef.current) {
      try {
        await fetchPromiseRef.current
      } catch {
        // Ignore fetch errors, we'll use whatever modelName we have
      }
    }
    
    // Use fetched modelName, or existingModelName, or 'default' as last resort
    const finalModel = modelName || existingModelName || 'default'
    
    try {
      await saveLocalModelConfig(finalUrl, finalModel, contextWindow ?? undefined)
      onDone()
    } catch (error) {
      console.error('Failed to save local model config:', error)
      onDone()
    }
  }

  const handleCancel = () => {
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort()
    }
    onDone()
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold={true}>
        {startingMessage ?? 'Configure Llama.cpp server.'}
      </Text>
      
      <Box flexDirection="column" gap={1}>
        <Text>Enter Llama.cpp server URL:</Text>
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

      {(modelName || existingModelName || fetchError || isAnalyzing) && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor={true}>
            {fetchError ? (
              <Text color="error">{fetchError}</Text>
            ) : modelName ? (
              <>
                <Text>Detected model: </Text>
                <Text bold={true}>{modelName}</Text>
                {contextWindow && (
                  <>
                    <Text> · Context: </Text>
                    <Text bold={true}>{contextWindow.toLocaleString()}</Text>
                  </>
                )}
                {isAnalyzing && <Text color="subtle"> (verifying...)</Text>}
              </>
            ) : existingModelName ? (
              <>
                <Text>Current model: </Text>
                <Text bold={true}>{existingModelName}</Text>
              </>
            ) : (
              <Text color="subtle">Detecting model...</Text>
            )}
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