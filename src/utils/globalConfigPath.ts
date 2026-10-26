import { join } from 'node:path'
import { getClaudeConfigHomeDir } from './envUtils.js'

/** Global settings now live inside the unified Codev data directory. */
export const GLOBAL_CONFIG_FILENAME = 'config.json'
export function globalConfigFileName(): string {
  return GLOBAL_CONFIG_FILENAME
}

/**
 * Path identity for the former global config document. Global config is now
 * persisted in `codev.db`; this path is retained only for diagnostics and
 * code paths that need a stable logical identifier.
 */
export function resolveGlobalConfigFilePath(
  configDirOverride?: string,
): string {
  const configHome = configDirOverride ?? getClaudeConfigHomeDir()
  return join(configHome, GLOBAL_CONFIG_FILENAME)
}
