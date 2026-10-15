/**
 * Session persistence gate — shared by the JSONL writer and the SQLite
 * shadow/mirror paths.
 *
 * Extracted from sessionStorage.ts so the db layer (shadowWriter, cache) can
 * reuse it WITHOUT statically importing sessionStorage (which imports the db
 * layer back — a static cycle). Keep this module dependency-light.
 */
import { isSessionPersistenceDisabled } from '../bootstrap/state.js'
import { isEnvTruthy } from './envUtils.js'
import { getSettings_DEPRECATED } from './settings/settings.js'

// Mirrors sessionStorage.getNodeEnv() — duplicated (2 lines) to keep this
// module free of a sessionStorage import.
function nodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

/**
 * DB-primary mode (D3 default): SQLite is the authoritative session store;
 * JSONL is a best-effort export for external tools. Enabled by default
 * outside tests; set CODEV_DB_PRIMARY=0/false to fall back to the legacy
 * JSONL-as-source-of-truth behavior. See
 * docs/architecture/session-storage-migration.md.
 */
export function isDbPrimaryMode(): boolean {
  const raw = process.env.CODEV_DB_PRIMARY
  // Empty string counts as unset (a bare `CODEV_DB_PRIMARY=` must not flip
  // the default off).
  if (raw !== undefined && raw !== '') return isEnvTruthy(raw)
  // Tests opt in explicitly so the suite stays hermetic and deterministic.
  if ((process.env.NODE_ENV || 'development') === 'test') return false
  return true
}

/**
 * True when test env / cleanupPeriodDays=0 / --no-session-persistence /
 * CLAUDE_CODE_SKIP_PROMPT_HISTORY should suppress all transcript persistence.
 * Shared by the Project write guards (appendEntry / materializeSessionFile)
 * and the SQLite read-through cache gate (a cache of session data IS
 * persistence, so a disabled-persistence run must not write one either).
 */
export function shouldSkipSessionPersistence(): boolean {
  const allowTestPersistence = isEnvTruthy(
    process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  )
  return (
    (nodeEnv() === 'test' && !allowTestPersistence) ||
    getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
    isSessionPersistenceDisabled() ||
    isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
  )
}
