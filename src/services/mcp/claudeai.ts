import type { ScopedMcpServerConfig } from './types.js'

/** Claude.ai hosted connectors are not supported by the 9router based CLI. */
export async function fetchClaudeAIMcpConfigsIfEligible(): Promise<
  Record<string, ScopedMcpServerConfig>
> {
  return {}
}

export function clearClaudeAIMcpConfigsCache(): void {}

export function markClaudeAiMcpConnected(_name: string): void {}

export function hasClaudeAiMcpEverConnected(_name: string): boolean {
  return false
}
