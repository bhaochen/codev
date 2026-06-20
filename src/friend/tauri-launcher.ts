/**
 * Tauri desktop app process management for Friend (VersperClaw native).
 *
 * Builds and launches the VRM desktop pet as a native Tauri window
 * (transparent, always-on-top) instead of a browser tab.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

let tauriProcess: ReturnType<typeof spawn> | null = null;

/**
 * Launch the Friend Tauri desktop window.
 * Uses the release binary (built via `npx tauri build`).
 * The binary loads the pre-built frontend from frontend/dist/.
 */
export function launchTauri(appDir: string, log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  const releaseBinary = path.join(appDir, 'src-tauri', 'target', 'release', 'versperclaw-friend')
  const debugBinary = path.join(appDir, 'src-tauri', 'target', 'debug', 'versperclaw-friend')

  const binary = existsSync(releaseBinary)
    ? releaseBinary
    : existsSync(debugBinary)
    ? debugBinary
    : null

  if (!binary) {
    log.warn(`Friend: Tauri binary not found. Run \`cd ${appDir} && npx tauri build\` first.`)
    log.warn(`Looking for: ${releaseBinary}`)
    return
  }

  log.info(`Starting Friend desktop window from ${binary}`)

  tauriProcess = spawn(binary, [], {
    cwd: appDir,
    stdio: 'pipe',
    detached: true,
  })

  tauriProcess.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log.info(line)
    }
  })

  tauriProcess.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log.info(line)
    }
  })

  tauriProcess.on('error', (err: Error) => {
    log.warn(`Friend Tauri error: ${err.message}`)
    tauriProcess = null
  })

  tauriProcess.on('exit', (code: number | null) => {
    log.info(`Friend Tauri exited (code: ${code})`)
    tauriProcess = null
  })
}

export function stopTauri(log: { info: (msg: string) => void }) {
  if (tauriProcess) {
    log.info('Stopping Friend Tauri window...')
    const proc = tauriProcess
    tauriProcess = null

    proc.kill('SIGTERM')
    setTimeout(() => {
      try { if (!proc.killed) proc.kill('SIGKILL') } catch { /* ignore */ }
    }, 3000)
  }
}

export function getTauriProcess(): ReturnType<typeof spawn> | null {
  return tauriProcess
}