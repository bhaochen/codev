/** Claude account OAuth is disabled; the CLI uses its configured 9router. */
export function shouldUseClaudeAIAuth(_scopes: string[] | undefined): boolean {
  return false
}

export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  return expiresAt !== null && Date.now() >= expiresAt
}

export async function getOrganizationUUID(): Promise<string | null> {
  return null
}
