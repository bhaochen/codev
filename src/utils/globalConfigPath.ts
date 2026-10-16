/**
 * Single source of truth for the global Claude configuration file path.
 *
 * Historically the CLI resolved this in `utils/env.ts` (`getGlobalClaudeFile`)
 * while the desktop server re-derived it inline in several places. Those server
 * copies all made the same mistake: they joined `.claude.json` onto
 * `process.env.CLAUDE_CONFIG_DIR || ~/.claude`, so by default they read
 * `~/.claude/.claude.json` — a file the CLI never writes — and silently saw no
 * config. Their own doc comments said "read ~/.claude.json", i.e. the code and
 * the intent disagreed.
 *
 * `resolveGlobalConfigFilePath()` is now the only resolver. The CLI's
 * `getGlobalClaudeFile()` delegates to it, and every server reader/writer calls
 * the same function, so the two can never disagree about which file holds the
 * config.
 *
 * Precedence (unchanged from the CLI's historical behaviour):
 *   1. `<config home>/.config.json` — legacy location, wins when it exists.
 *   2. `<$CLAUDE_CONFIG_DIR || $HOME>/.claude<oauth suffix>.json`, where the
 *      suffix follows the OAuth environment (`fileSuffixForOauthConfig`).
 *
 * An explicit `configDirOverride` (the doctor's `configDir` option) is treated
 * as the config home for both steps instead of the environment default.
 */
import { homedir } from 'os'
import { join } from 'path'
import { fileSuffixForOauthConfig } from '../constants/oauth.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'

/** Legacy global-config filename, resolved inside the config home. */
export const LEGACY_GLOBAL_CONFIG_FILENAME = '.config.json'

/**
 * The (OAuth-environment dependent) global config filename, e.g. `.claude.json`
 * in production or `.claude-local-oauth.json` when pointed at a local OAuth
 * server.
 */
export function globalConfigFileName(): string {
  return `.claude${fileSuffixForOauthConfig()}.json`
}

/**
 * Resolve the absolute path of the global Claude config file.
 *
 * @param configDirOverride Optional config home (e.g. the doctor's
 *   `configDir`). When omitted, `$CLAUDE_CONFIG_DIR` (or the user's home) is
 *   used, matching CLI behaviour exactly.
 */
export function resolveGlobalConfigFilePath(
  configDirOverride?: string,
): string {
  const configDir = configDirOverride ?? process.env.CLAUDE_CONFIG_DIR
  const configHome = configDir
    ? configDir.normalize('NFC')
    : getClaudeConfigHomeDir()

  // Legacy location wins when present (pre-existing CLI behaviour).
  const legacyPath = join(configHome, LEGACY_GLOBAL_CONFIG_FILENAME)
  if (getFsImplementation().existsSync(legacyPath)) {
    return legacyPath
  }

  return join(configDir || homedir(), globalConfigFileName())
}
