import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'

export interface LaunchedBrowser {
  child: ChildProcess
  port: number
  /** Browser-level CDP WebSocket URL (ws://127.0.0.1:port/devtools/browser/...). */
  wsUrl: string
  executable: string
}

function windowsCandidates(): string[] {
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const programFilesX86 =
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData =
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return [
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
  ]
}

function darwinCandidates(): string[] {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
}

const LINUX_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
]

/**
 * Finds a Chromium-based browser executable. `CODEV_BROWSER_PATH` overrides
 * discovery. Returns null when nothing is installed.
 */
export async function findBrowserExecutable(): Promise<string | null> {
  const override = process.env.CODEV_BROWSER_PATH
  if (override) {
    return existsSync(override) ? override : null
  }
  if (process.platform === 'win32') {
    return windowsCandidates().find(p => existsSync(p)) ?? null
  }
  if (process.platform === 'darwin') {
    return darwinCandidates().find(p => existsSync(p)) ?? null
  }
  for (const cmd of LINUX_COMMANDS) {
    const { code, stdout } = await execFileNoThrow('which', [cmd], {
      timeout: 5_000,
    })
    const found = stdout.trim()
    if (code === 0 && found) return found
  }
  return null
}

export function getBrowserProfileDir(): string {
  return (
    process.env.CODEV_BROWSER_PROFILE_DIR ||
    join(getClaudeConfigHomeDir(), 'browser-profile')
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Launches the browser with a dedicated automation profile and
 * `--remote-debugging-port=0`, then reads the `DevToolsActivePort` file the
 * browser writes into the profile dir to learn the actual port and browser
 * WebSocket path. This is the race-free way to get a debugging endpoint
 * (fixed ports collide with other sessions and stale processes).
 */
export async function launchBrowser(options: {
  headless?: boolean
  signal?: AbortSignal
}): Promise<LaunchedBrowser> {
  const executable = await findBrowserExecutable()
  if (!executable) {
    throw new Error(
      'No Chromium-based browser found (looked for Chrome, Edge, Brave, Chromium). ' +
        'Install one, or set CODEV_BROWSER_PATH to the browser executable.',
    )
  }

  const profileDir = getBrowserProfileDir()
  mkdirSync(profileDir, { recursive: true })
  const portFile = join(profileDir, 'DevToolsActivePort')
  try {
    rmSync(portFile, { force: true })
  } catch {
    // A live browser holding the file open means this profile is already in
    // use; the poll below will then read a fresh file or time out.
  }

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // AutomationControlled is the big anti-bot tell: leaving it on advertises
    // navigator.webdriver=true and shows the "controlled by automated test
    // software" infobar, which sites like Google use to gate CAPTCHAs.
    '--disable-blink-features=AutomationControlled',
    '--disable-features=DefaultBrowserSettingEnabled,AutomationControlled,Translate',
    // A stable, human-plausible locale; a missing/odd Accept-Language is another
    // fingerprinting signal. The page-side stealth script matches this.
    '--lang=en-US',
    '--window-size=1280,900',
    ...(options.headless ? ['--headless=new'] : []),
    'about:blank',
  ]

  const child = spawn(executable, args, {
    stdio: 'ignore',
    // Detached would orphan the browser on exit; keep it attached so
    // child.kill() works and the OS cleans up with us.
    detached: false,
  })

  let spawnError: Error | undefined
  child.once('error', error => {
    spawnError = error
  })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      child.kill()
      throw new Error('Browser launch aborted')
    }
    if (spawnError) {
      throw new Error(`Failed to start browser: ${spawnError.message}`)
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Browser exited immediately (code ${child.exitCode}). ` +
          'Another instance may already be using the automation profile.',
      )
    }
    if (existsSync(portFile)) {
      try {
        const [portLine, wsPath] = readFileSync(portFile, 'utf8').split('\n')
        const port = Number((portLine ?? '').trim())
        if (Number.isInteger(port) && port > 0 && wsPath?.trim()) {
          return {
            child,
            port,
            wsUrl: `ws://127.0.0.1:${port}${wsPath.trim()}`,
            executable,
          }
        }
      } catch {
        // Partially written file; retry.
      }
    }
    await sleep(150)
  }

  child.kill()
  throw new Error(
    'Browser started but did not expose a DevTools endpoint within 20s.',
  )
}

/**
 * Resolves the browser-level WebSocket URL of an already-running browser that
 * was started with --remote-debugging-port (opt-in via CODEV_BROWSER_CONNECT_PORT,
 * which attaches to the user's real, possibly logged-in browser instead of the
 * isolated automation profile).
 */
export async function resolveExistingBrowser(
  port: number,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: signal ?? null,
  })
  if (!response.ok) {
    throw new Error(
      `No debuggable browser on port ${port} (HTTP ${response.status})`,
    )
  }
  const info = (await response.json()) as { webSocketDebuggerUrl?: string }
  if (!info.webSocketDebuggerUrl) {
    throw new Error(`Browser on port ${port} did not report a WebSocket URL`)
  }
  return info.webSocketDebuggerUrl
}
