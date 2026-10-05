/**
 * Whether Groq applies its curated small-tier tool filter for this model.
 */
export function isSmallTierGroqModel(model: string): boolean {
  const normalized = model.toLowerCase()
  return normalized.startsWith('llama-') || normalized.includes('gpt-oss')
}

const GROQ_SMALL_TIER_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Agent',
  'Skill',
  'Eval',
])

/** Exact companion to the Groq small-tier tool filter. */
export function isToolKeptByGroqSmallTierFilter(
  model: string,
  toolName: string,
): boolean {
  if (!isSmallTierGroqModel(model)) return true
  return (
    GROQ_SMALL_TIER_TOOL_ALLOWLIST.has(toolName) ||
    toolName.startsWith('mcp__')
  )
}
