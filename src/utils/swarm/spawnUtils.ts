/**
 * Shared utilities for spawning teammates across different backends.
 */

import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { readlinkSync } from 'fs'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'

/**
 * Resolves the real executable path for the current process.
 *
 * In bun-compiled mode, process.execPath may return a bunfs virtual path
 * (e.g., /$bunfs/root/Codev) that only exists within the bun runtime.
 * When a tmux pane tries to execute this path in a regular shell, it fails
 * with "No such file or directory".
 *
 * Fix: use /proc/self/exe on Linux to resolve the real binary path.
 * On unsupported platforms, falls back to process.execPath.
 */
function resolveRealExecPath(): string {
  try {
    if (process.platform === 'linux') {
      return readlinkSync('/proc/self/exe')
    }
  } catch {
    // Not on Linux or /proc not available — fall through
  }
  return process.execPath
}

/**
 * Gets the command to use for spawning teammate processes.
 * Uses TEAMMATE_COMMAND_ENV_VAR if set, otherwise falls back to the
 * current process executable path.
 */
export function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? resolveRealExecPath() : process.argv[1]!
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  }

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --teammate-mode so tmux teammates use the same mode as leader
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push(`--teammate-mode ${sessionMode}`)

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Environment variables that must be explicitly forwarded to tmux-spawned
 * teammates. Tmux may start a new login shell that doesn't inherit the
 * parent's env, so we forward any that are set in the current process.
 */
const TEAMMATE_ENV_VARS = [
  // Explicit provider override — without these, spawned teammates can fall
  // back to firstParty even when the leader is pinned to OpenCode/OpenAI/etc.
  'BETTER_CLAWD_API_PROVIDER',
  'CLAUDE_CODE_API_PROVIDER',
  // API provider selection — without these, teammates default to firstParty
  // and send requests to the wrong endpoint (GitHub issue #23561)
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Custom API endpoint
  'ANTHROPIC_BASE_URL',
  // Config directory override
  'CLAUDE_CONFIG_DIR',
  // CCR marker — teammates need this for CCR-aware code paths. Auth finds
  // its own way via /home/claude/.claude/remote/.oauth_token regardless;
  // the FD env var wouldn't help (pipe FDs don't cross tmux).
  'CLAUDE_CODE_REMOTE',
  // Auto-memory gate (memdir/paths.ts) checks REMOTE && !MEMORY_DIR to
  // disable memory on ephemeral CCR filesystems. Forwarding REMOTE alone
  // would flip teammates to memory-off when the parent has it on.
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  // Upstream proxy — the parent's MITM relay is reachable from teammates
  // (same container network). Forward the proxy vars so teammates route
  // customer-configured upstream traffic through the relay for credential
  // injection. Without these, teammates bypass the proxy entirely.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  // Third-party provider endpoints / auth overrides that may be configured
  // only in the parent shell environment.
  'OPENAI_API_KEY',
  'OPENAI_ACCESS_TOKEN',
  'CODEX_ACCESS_TOKEN',
  'OPENROUTER_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_BASE_URL',
  'OPENCODE_BASE_URL',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

/**
 * Builds a map of environment variables for teammate spawn commands.
 * Skips CLAUDECODE and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS if already set
 * in the current environment (e.g., from settings.json env or tmux global env).
 *
 * Returns a Record<string, string> suitable for tmux -e flags or manual
 * env KEY=VALUE construction.
 */
export function buildInheritedEnvMap(): Record<string, string> {
  const envMap: Record<string, string> = {}

  // Only hardcode these if NOT already set in process env — the user may
  // have them in ~/.claude/settings.json env, tmux set-environment, etc.
  if (!process.env.CLAUDECODE) {
    envMap.CLAUDECODE = '1'
  }
  if (!process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) {
    envMap.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  }

  for (const key of TEAMMATE_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      envMap[key] = value
    }
  }

  return envMap
}

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Delegates to buildInheritedEnvMap() for the values.
 */
export function buildInheritedEnvVars(): string {
  const envMap = buildInheritedEnvMap()
  return Object.entries(envMap)
    .map(([key, value]) => `${key}=${quote([value])}`)
    .join(' ')
}
