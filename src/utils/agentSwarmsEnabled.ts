/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * Free-code: always enabled by default.
 * Set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0 to explicitly disable.
 */
export function isAgentSwarmsEnabled(): boolean {
  // Explicit opt-out
  if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '0') {
    return false
  }

  return true
}
