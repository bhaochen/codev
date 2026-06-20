/**
 * Tauri desktop app process management for Friend (VersperClaw native).
 *
 * Launches the VRM desktop pet as a native Tauri window.
 * Also manages a background server on port 3456 that serves the frontend.
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

let tauriProcess: ReturnType<typeof spawn> | null = null;
let serverProcess: ReturnType<typeof spawn> | null = null;

const SERVER_PORT = 3456
const FRIEND_URL = `http://127.0.0.1:${SERVER_PORT}/friend/`

/** Check if the friend server is already listening. */
function isServerRunning(): boolean {
  try {
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${SERVER_PORT}/friend/ 2>/dev/null || true`,
      { timeout: 3000, encoding: 'utf-8' },
    )
    return result.trim() === '200'
  } catch {
    return false
  }
}

/** Wait until the server responds, up to `timeoutMs`. */
function waitForServer(timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const check = () => {
      if (isServerRunning()) return resolve(true)
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(check, 500)
    }
    check()
  })
}

/** Start the backend server if not already running. */
async function ensureServer(log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  if (isServerRunning()) {
    log.info('[Friend] Server already running')
    return true
  }

  const cwd = process.cwd()
  const serverEntry = path.join(cwd, 'src', 'server', 'index.ts')
  if (!existsSync(serverEntry)) {
    log.warn(`[Friend] Server entry not found: ${serverEntry}`)
    return false
  }

  log.info('[Friend] Starting background server...')
  serverProcess = spawn('bun', ['run', serverEntry, `--port=${SERVER_PORT}`], {
    cwd,
    stdio: 'pipe',
    detached: true,
  })

  serverProcess.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log.info(`[Friend:server] ${line}`)
    }
  })

  const ok = await waitForServer()
  if (!ok) log.warn('[Friend] Server did not become ready in time')
  return ok
}

export async function launchTauri(log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  // 1. Ensure the server is running (Tauri loads from HTTP)
  const serverOk = await ensureServer(log)
  if (!serverOk) {
    log.warn('[Friend] Cannot start — server failed to start')
    return
  }

  // 2. Find the Tauri binary
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

  // 3. Launch the Tauri desktop window (it connects to FRIEND_URL via lib.rs)
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
  if (serverProcess) {
    log.info('[Friend] Stopping background server...')
    const proc = serverProcess
    serverProcess = null
    proc.kill('SIGTERM')
  }
}

export function getTauriProcess(): ReturnType<typeof spawn> | null {
  return tauriProcess
}
