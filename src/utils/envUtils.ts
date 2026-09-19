import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

// Memoized: 150+ callers, many on hot paths. Keyed off CLAUDE_CONFIG_DIR so
// tests that change the env var get a fresh value without explicit cache.clear.
export const getClaudeConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    ).normalize('NFC')
  },
  () => process.env.CLAUDE_CONFIG_DIR,
)

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

export type BareModeLevel =
  | 'extreme'
  | 'ultra'
  | 'max'
  | 'high'
  | 'medium'
  | 'low'

const BARE_MODE_LEVELS: readonly BareModeLevel[] = [
  'extreme',
  'ultra',
  'max',
  'high',
  'medium',
  'low',
]

export function getBareModeLevel(): BareModeLevel | null {
  const configuredLevel = process.env.CLAUDE_CODE_BARE_LEVEL?.trim().toLowerCase()
  if (BARE_MODE_LEVELS.includes(configuredLevel as BareModeLevel)) {
    return configuredLevel as BareModeLevel
  }

  const simple = process.env.CLAUDE_CODE_SIMPLE?.trim().toLowerCase()
  if (simple && BARE_MODE_LEVELS.includes(simple as BareModeLevel)) {
    return simple as BareModeLevel
  }
  if (isEnvTruthy(simple)) return 'max'
  if (process.argv.includes('--bare')) return 'max'

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('fs') as typeof import('fs')
    const { getGlobalClaudeFile } = require('./env.js') as typeof import('./env.js')
    const raw = readFileSync(getGlobalClaudeFile(), 'utf8')
    const config = JSON.parse(raw) as {
      bareModeLevel?: string
      bareModeEnabled?: boolean
    }
    if (BARE_MODE_LEVELS.includes(config.bareModeLevel as BareModeLevel)) {
      return config.bareModeLevel as BareModeLevel
    }
    if (config.bareModeEnabled === true) return 'max'
  } catch {
    // Ignore errors while resolving early startup configuration.
  }
  return null
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 *
 * Also checks global config for bareModeEnabled setting.
 */
export function isBareMode(): boolean {
  return getBareModeLevel() !== null
}

export function shouldSuppressBarePromptExtras(): boolean {
  const bareLevel = getBareModeLevel()
  return bareLevel !== null && bareLevel !== 'low'
}

export function getBarePromptPressureRatio(): number {
  const bareLevel = getBareModeLevel()
  if (!bareLevel || bareLevel === 'low') return 1

  // Bare mode is implemented by suppressing specific prompt sources rather than
  // by shortening a single visible string. Compute the ratio from the sources
  // actually disabled in each level so compact thresholds reflect the real
  // request cost, not just the length of the identity line.
  // Tool schema is often the dominant prompt consumer in small-context local
  // models, so it gets a heavier weight than the visible system prompt string.
  const sourceWeights = {
    systemPrompt: 0.2,
    toolSchema: 0.6,
    userContext: 0.1,
    systemContext: 0.05,
    customPrompt: 0.05,
  } as const

  const levelRatios: Record<Exclude<BareModeLevel, 'low'>, typeof sourceWeights> = {
    medium: {
      systemPrompt: 0.8,
      toolSchema: 0.75,
      userContext: 0,
      systemContext: 0,
      customPrompt: 0,
    },
    high: {
      systemPrompt: 0.62,
      toolSchema: 0.55,
      userContext: 0,
      systemContext: 0,
      customPrompt: 0,
    },
    max: {
      systemPrompt: 0.36,
      toolSchema: 0.3,
      userContext: 0,
      systemContext: 0,
      customPrompt: 0,
    },
    ultra: {
      systemPrompt: 0.12,
      toolSchema: 0.04,
      userContext: 0,
      systemContext: 0,
      customPrompt: 0,
    },
    extreme: {
      systemPrompt: 0.04,
      toolSchema: 0,
      userContext: 0,
      systemContext: 0,
      customPrompt: 0,
    },
  }

  const sourceRatio = levelRatios[bareLevel]
  const weightedRatio =
    sourceWeights.systemPrompt * sourceRatio.systemPrompt +
    sourceWeights.toolSchema * sourceRatio.toolSchema +
    sourceWeights.userContext * sourceRatio.userContext +
    sourceWeights.systemContext * sourceRatio.systemContext +
    sourceWeights.customPrompt * sourceRatio.customPrompt

  return Math.min(1, Math.max(0, weightedRatio))
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether Claude Code is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
