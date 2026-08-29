// Stub for the ant-internal `@ant/computer-use-mcp/sentinelApps` module.
// The real package is externalized at build time (dead code path); this
// mirrors the SentinelCategory contract used by ComputerUseApproval.
export type SentinelCategory = 'shell' | 'filesystem' | 'system_settings'

export function getSentinelCategory(_bundleId: string): SentinelCategory | null {
  return null
}
