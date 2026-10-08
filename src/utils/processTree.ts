import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import treeKill from 'tree-kill'

/**
 * Locate Windows' own `taskkill.exe` by absolute path.
 *
 * tree-kill runs `exec('taskkill …')` on Windows, and cmd.exe resolves a bare
 * `taskkill` from the current folder before PATH — so a `taskkill.bat` (or
 * `taskkill.exe`) dropped in the project would run on every interrupt. Spawn
 * System32's real binary instead, without a shell.
 *
 * Never guesses the drive; returns null when neither SystemRoot nor WINDIR is
 * usable, so the caller can fall back to direct termination.
 */
export function resolveWindowsTaskkillPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const value of [env.SystemRoot, env.WINDIR]) {
    const windowsRoot = value?.trim()
    if (
      windowsRoot &&
      win32.isAbsolute(windowsRoot) &&
      !/[\0\r\n]/.test(windowsRoot)
    ) {
      return win32.join(windowsRoot, 'System32', 'taskkill.exe')
    }
  }
  return null
}

type KillProcessTreeDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawnImpl?: typeof spawn
  treeKillImpl?: typeof treeKill
  processKillImpl?: typeof process.kill
}

/**
 * Kill `pid` and all of its descendants. Fire-and-forget, like tree-kill.
 *
 * On Windows the hardened taskkill path above is used; other platforms keep
 * tree-kill. A failed kill stays silent, exactly like tree-kill.
 */
export function killProcessTree(
  pid: number,
  {
    platform = process.platform,
    env = process.env,
    spawnImpl = spawn,
    treeKillImpl = treeKill,
    processKillImpl = process.kill.bind(process),
  }: KillProcessTreeDeps = {},
): void {
  if (platform !== 'win32') {
    treeKillImpl(pid, 'SIGKILL')
    return
  }

  const taskkillPath = resolveWindowsTaskkillPath(env)
  if (!taskkillPath) {
    // Never guess the Windows drive or trust a PATH/cwd taskkill. Killing
    // the shell alone is the safe degraded mode.
    try {
      processKillImpl(pid, 'SIGKILL')
    } catch {
      // The process already exited.
    }
    return
  }

  try {
    const taskkill = spawnImpl(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      // Node ends attached children when it exits; the kill must outlive us.
      detached: true,
      windowsHide: true,
    })
    // A failed spawn (e.g. ENOENT) emits 'error' asynchronously. Unhandled,
    // it would crash the process.
    taskkill.once('error', () => {})
  } catch {
    // Like tree-kill, a failed kill stays silent.
  }
}
