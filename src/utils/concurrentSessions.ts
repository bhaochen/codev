import { feature } from 'bun:bundle'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getPlatform } from './platform.js'
import { getAgentId } from './teammate.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

/**
 * Live-session registry, stored in the shared sessions DB
 * (`session_processes` table — migration 009) instead of per-PID JSON files
 * in `<configHome>/sessions/`. One row per live codev process, keyed by PID,
 * payload identical to the old file. Clean exits delete the row; crashed
 * sessions are swept by the same liveness probe the stale-file sweep used.
 *
 * The db layer is imported dynamically: this module sits under bootstrap /
 * sessionStorage (which the db layer imports back — a static import would
 * close a cycle).
 */
async function withStore<T>(
  fn: (store: import('../services/db/SessionStore.js').SessionStore) => T,
): Promise<T | null> {
  try {
    const { getSessionStore } = await import('../services/db/SessionStore.js')
    return fn(getSessionStore())
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] session store unavailable: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * Kind override from env. Set by the spawner (`claude --bg`, daemon
 * supervisor) so the child can register without the parent having to
 * write the file for it — cleanup-on-exit wiring then works for free.
 * Gated so the env-var string is DCE'd from external builds.
 */
function envSessionKind(): SessionKind | undefined {
  if (feature('BG_SESSIONS')) {
    const k = process.env.CLAUDE_CODE_SESSION_KIND
    if (k === 'bg' || k === 'daemon' || k === 'daemon-worker') return k
  }
  return undefined
}

/**
 * True when this REPL is running inside a `claude --bg` tmux session.
 * Exit paths (/exit, ctrl+c, ctrl+d) should detach the attached client
 * instead of killing the process.
 */
export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

/**
 * Register this session in the process registry and register cleanup.
 *
 * Registers all top-level sessions — interactive CLI, SDK (vscode, desktop,
 * typescript, python, -p), bg/daemon spawns — so `claude ps` sees everything
 * the user might be running. Skips only teammates/subagents, which would
 * conflate swarm usage with genuine concurrency and pollute ps with noise.
 *
 * Returns true if registered, false if skipped.
 * Errors logged to debug, never thrown.
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false

  const kind: SessionKind = envSessionKind() ?? 'interactive'

  registerCleanup(async () => {
    await withStore(store => {
      store.deleteSessionProcess(process.pid)
    })
  })

  const registered = await withStore(store => {
    store.upsertSessionProcess(process.pid, {
      pid: process.pid,
      sessionId: getSessionId(),
      cwd: getOriginalCwd(),
      startedAt: Date.now(),
      kind,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      ...(feature('UDS_INBOX')
        ? { messagingSocketPath: process.env.CLAUDE_CODE_MESSAGING_SOCKET }
        : {}),
      ...(feature('BG_SESSIONS')
        ? {
            name: process.env.CLAUDE_CODE_SESSION_NAME,
            logPath: process.env.CLAUDE_CODE_SESSION_LOG,
            agent: process.env.CLAUDE_CODE_AGENT,
          }
        : {}),
    })
    return true
  })
  if (!registered) return false

  // --resume / /resume mutates getSessionId() via switchSession. Without
  // this, the registry row's sessionId goes stale and `claude ps` sparkline
  // reads the wrong transcript.
  onSessionSwitch(id => {
    void updateSessionProcess({ sessionId: id })
  })
  return true
}

/**
 * Patch this session's registry row (read-modify-write of data_json).
 * Best-effort: silently no-ops when the session isn't registered or the
 * store is unavailable.
 */
async function updateSessionProcess(
  patch: Record<string, unknown>,
): Promise<void> {
  await withStore(store => {
    const existing = store.getSessionProcess(process.pid)
    if (!existing) return
    store.upsertSessionProcess(process.pid, { ...existing, ...patch })
  })
}

export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updateSessionProcess({ name })
}

/**
 * Record this session's Remote Control session ID so peer enumeration can
 * dedup: a session reachable over both UDS and bridge should only appear
 * once (local wins). Cleared on bridge teardown so stale IDs don't
 * suppress a legitimately-remote session after reconnect.
 */
export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updateSessionProcess({ bridgeSessionId })
}

/**
 * Push live activity state for `claude ps`. Fire-and-forget from REPL's
 * status-change effect — a dropped write just means ps falls back to
 * transcript-tail derivation for one refresh.
 */
export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  if (!feature('BG_SESSIONS')) return
  await updateSessionProcess({ ...patch, updatedAt: Date.now() })
}

/**
 * Count live concurrent CLI sessions (including this one).
 * Filters out rows whose process is gone (crashed sessions) and deletes
 * them. Returns 0 on any error (conservative).
 */
export async function countConcurrentSessions(): Promise<number> {
  const rows = await withStore(store => store.listSessionProcessPids())
  if (rows === null) return 0

  let count = 0
  for (const pid of rows) {
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // Stale row from a crashed session — sweep it. Skip on WSL: if
      // the sessions DB is shared with Windows-native Claude (symlink
      // or CLAUDE_CONFIG_DIR), a Windows PID won't be probeable from WSL
      // and we'd falsely delete a live session's row. This is just
      // telemetry so conservative undercount is acceptable.
      await withStore(store => {
        store.deleteSessionProcess(pid)
      })
    }
  }
  return count
}
