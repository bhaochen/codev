import { useCallback, useEffect, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { verifyApiKey } from '../services/api/auth/verifyApiKey.js'
import { getGlobalConfig } from '../utils/config.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
  getConfiguredAuthProvider,
  getConfiguredAuthProviderFromFile,
  getOpenAIAuthTokens,
  getLocalBaseUrl,
  getLocalModelName,
} from '../utils/auth.js'
import { useAppState } from '../state/AppState.js'

export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

export function useApiKeyVerification(): ApiKeyVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>(() => {
    const authProvider = getConfiguredAuthProviderFromFile()
    
    // Check Local authentication
    if (authProvider === 'local') {
      const baseUrl = getLocalBaseUrl()
      const modelName = getLocalModelName()
      if (baseUrl && modelName) {
        return 'valid'
      }
      return 'missing'
    }
    
    // Check OpenAI authentication
    if (authProvider === 'openai') {
      const config = getGlobalConfig()
      const hasApiKey = !!config.openAiApiKey
      const hasAccessToken = !!config.openAiAccessToken
      if (hasApiKey || hasAccessToken) {
        return 'valid'
      }
      return 'missing'
    }
    
    // Check OpenRouter authentication
    if (authProvider === 'openrouter') {
      const config = getGlobalConfig()
      const hasApiKey = !!config.openRouterApiKey
      if (hasApiKey) {
        return 'valid'
      }
      return 'missing'
    }

    // Check OpenCode Zen authentication
    // OpenCode Zen uses free models by default, no API key required
    if (authProvider === 'opencode') {
      return 'valid'
    }

    // Check NVIDIA authentication
    if (authProvider === 'nvidia') {
      const config = getGlobalConfig()
      const hasApiKey = !!config.nvidiaApiKey
      if (hasApiKey) {
        return 'valid'
      }
      return 'missing'
    }

    // Anthropic authentication
    if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) {
      return 'valid'
    }
    // Use skipRetrievingKeyFromApiKeyHelper to avoid executing apiKeyHelper
    // before trust dialog is shown (security: prevents RCE via settings.json)
    const { key, source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    // If apiKeyHelper is configured, we have a key source even though we
    // haven't executed it yet - return 'loading' to indicate we'll verify later
    if (key || source === 'apiKeyHelper') {
      return 'loading'
    }
    return 'missing'
  })
  const [error, setError] = useState<Error | null>(null)

  // Watch authVersion changes to re-verify API key
  const authVersion = useAppState(s => s.authVersion)

  useEffect(() => {
    // When authVersion changes, re-verify the API key
    const reverify = async (): Promise<void> => {
      const authProvider = getConfiguredAuthProviderFromFile()
      console.log('[useApiKeyVerification] authVersion changed, authProvider:', authProvider)
      
      // Check Local authentication
      if (authProvider === 'local') {
        // Force re-read config by reading directly from file
        const baseUrl = getLocalBaseUrl()
        const modelName = getLocalModelName()
        console.log('[useApiKeyVerification] Local - baseUrl:', baseUrl, 'modelName:', modelName)
        if (baseUrl && modelName) {
          setStatus('valid')
        } else {
          setStatus('missing')
        }
        return
      }
      
      // Check OpenAI authentication
      if (authProvider === 'openai') {
        const { getGlobalConfig: getConfig } = await import('../utils/config.js')
        const freshConfig = getConfig()
        const hasApiKey = !!freshConfig.openAiApiKey
        const hasAccessToken = !!freshConfig.openAiAccessToken
        if (hasApiKey || hasAccessToken) {
          setStatus('valid')
        } else {
          setStatus('missing')
        }
        return
      }
      
      // Check OpenRouter authentication
      if (authProvider === 'openrouter') {
        const { getGlobalConfig: getConfig } = await import('../utils/config.js')
        const freshConfig = getConfig()
        const hasApiKey = !!freshConfig.openRouterApiKey
        if (hasApiKey) {
          setStatus('valid')
        } else {
          setStatus('missing')
        }
        return
      }
      
      // Check OpenCode Zen authentication
      if (authProvider === 'opencode') {
        setStatus('valid')
        return
      }

      // Check NVIDIA authentication
      if (authProvider === 'nvidia') {
        const { getGlobalConfig: getConfig } = await import('../utils/config.js')
        const freshConfig = getConfig()
        const hasApiKey = !!freshConfig.nvidiaApiKey
        if (hasApiKey) {
          setStatus('valid')
        } else {
          setStatus('missing')
        }
        return
      }

      // Anthropic authentication
      if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) {
        setStatus('valid')
        return
      }
      // Warm the apiKeyHelper cache (no-op if not configured), then read from
      // all sources. getAnthropicApiKeyWithSource() reads the now-warm cache.
      await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
      const { key: apiKey, source } = getAnthropicApiKeyWithSource()
      if (!apiKey) {
        if (source === 'apiKeyHelper') {
          setStatus('error')
          setError(new Error('API key helper did not return a valid key'))
          return
        }
        const newStatus = 'missing'
        setStatus(newStatus)
        return
      }

      try {
        const isValid = await verifyApiKey(apiKey, false)
        const newStatus = isValid ? 'valid' : 'invalid'
        setStatus(newStatus)
        return
      } catch (error) {
        // This happens when there an error response from the API but it's not an invalid API key error
        // In this case, we still mark the API key as invalid - but we also log the error so we can
        // display it to the user to be more helpful
        setError(error as Error)
        const newStatus = 'error'
        setStatus(newStatus)
        return
      }
    }

    void reverify()
  }, [authVersion])

  const verify = useCallback(async (): Promise<void> => {
    const authProvider = getConfiguredAuthProviderFromFile()
    
    // Check Local authentication
    if (authProvider === 'local') {
      const baseUrl = getLocalBaseUrl()
      const modelName = getLocalModelName()
      if (baseUrl && modelName) {
        setStatus('valid')
      } else {
        setStatus('missing')
      }
      return
    }
    
    // Check OpenAI authentication
    if (authProvider === 'openai') {
      const config = getGlobalConfig()
      const hasApiKey = !!config.openAiApiKey
      const hasAccessToken = !!config.openAiAccessToken
      if (hasApiKey || hasAccessToken) {
        setStatus('valid')
      } else {
        setStatus('missing')
      }
      return
    }
    
    // Check OpenRouter authentication
    if (authProvider === 'openrouter') {
      const config = getGlobalConfig()
      const hasApiKey = !!config.openRouterApiKey
      if (hasApiKey) {
        setStatus('valid')
      } else {
        setStatus('missing')
      }
      return
    }
    
    // Check OpenCode Zen authentication
    if (authProvider === 'opencode') {
      setStatus('valid')
      return
    }

    // Check NVIDIA authentication
    if (authProvider === 'nvidia') {
      const config = getGlobalConfig()
      const hasApiKey = !!config.nvidiaApiKey
      if (hasApiKey) {
        setStatus('valid')
      } else {
        setStatus('missing')
      }
      return
    }

    // Anthropic authentication
    if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) {
      setStatus('valid')
      return
    }
    // Warm the apiKeyHelper cache (no-op if not configured), then read from
    // all sources. getAnthropicApiKeyWithSource() reads the now-warm cache.
    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    const { key: apiKey, source } = getAnthropicApiKeyWithSource()
    if (!apiKey) {
      if (source === 'apiKeyHelper') {
        setStatus('error')
        setError(new Error('API key helper did not return a valid key'))
        return
      }
      const newStatus = 'missing'
      setStatus(newStatus)
      return
    }

    try {
      const isValid = await verifyApiKey(apiKey, false)
      const newStatus = isValid ? 'valid' : 'invalid'
      setStatus(newStatus)
      return
    } catch (error) {
      // This happens when there an error response from the API but it's not an invalid API key error
      // In this case, we still mark the API key as invalid - but we also log the error so we can
      // display it to the user to be more helpful
      setError(error as Error)
      const newStatus = 'error'
      setStatus(newStatus)
      return
    }
  }, [])

  return {
    status,
    reverify: verify,
    error,
  }
}
