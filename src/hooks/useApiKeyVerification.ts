import { useCallback, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { verifyApiKey } from '../services/api/claude.js'
import { getGlobalConfig } from '../utils/config.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
  getConfiguredAuthProvider,
  getOpenAIAuthTokens,
} from '../utils/auth.js'

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
    const authProvider = getConfiguredAuthProvider()
    
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

  const verify = useCallback(async (): Promise<void> => {
    const authProvider = getConfiguredAuthProvider()
    
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
