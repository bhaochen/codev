/**
 * Tauri desktop app process management for Friend (VersperClaw native).
 *
 * Launches the VRM desktop pet as a native Tauri window.
 * The HTTP server runs in-process via friend/server.ts —
 * no separate server subprocess needed.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

let tauriProcess: ReturnType<typeof spawn> | null = null;

export async function launchTauri(log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  // Find the Tauri binary
  const cwd = process.cwd()
  const releaseBinary = path.join(cwd, 'src', 'components', 'friend', 'frontend', 'src-tauri', 'target', 'release', 'versperclaw-friend')
  const debugBinary = path.join(cwd, 'src', 'components', 'friend', 'frontend', 'src-tauri', 'target', 'debug', 'versperclaw-friend')

  const binary = existsSync(releaseBinary) ? releaseBinary
    : existsSync(debugBinary) ? debugBinary
    : null

  if (!binary) {
    log.warn(`[Friend] Tauri binary not found. Run \`cd src/components/friend/frontend && npx tauri build\` first.`)
    log.warn(`[Friend] Looked for: ${releaseBinary}`)
    return
  }

  log.info(`[Friend] Starting desktop window from ${binary}`)

  tauriProcess = spawn(binary, [], {
    cwd: path.dirname(binary),
    stdio: 'pipe',
    detached: true,
  })

  tauriProcess.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log.info(`[Friend:tauri] ${line}`)
    }
  })

  tauriProcess.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log.info(`[Friend:tauri] ${line}`)
    }
  })

  tauriProcess.on('error', (err: Error) => {
    log.warn(`[Friend] Tauri error: ${err.message}`)
    tauriProcess = null
  })

  tauriProcess.on('exit', (code: number | null) => {
    log.info(`[Friend] Tauri exited (code: ${code})`)
    tauriProcess = null
  })
}

export function stopTauri(log: { info: (msg: string) => void }) {
  if (tauriProcess) {
    log.info('[Friend] Stopping Tauri window...')
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
