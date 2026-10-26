export type VerificationStatus = 'loading' | 'valid' | 'invalid' | 'missing' | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

/** The configured 9router gateway owns authentication; Codev has no local provider key to verify. */
export function useApiKeyVerification(): ApiKeyVerificationResult {
  return {
    status: 'valid',
    reverify: async () => {},
    error: null,
  }
}
