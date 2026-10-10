/**
 * Linux/Wayland desktop control executor for Arch Hyprland.
 *
 * Uses:
 *   - grim + slurp     — Wayland screenshots (Hyprland)
 *   - hyprctl          — window management, workspace, focus
 *   - ydotool          — mouse/keyboard input (Wayland)
 *   - wtype            — alternative input (newer, wlroots-based)
 *
 * Design mirrors macos-harness: see, key, type, click, window primitives.
 * One persistent process, agent writes what is missing.
 *
 * This implements the @ant/computer-use-mcp ComputerExecutor interface
 * so it can be swapped in for the macOS executor.
 */

import { execFile, execFileNoThrow } from '../execFileNoThrow.js'
import { sleep } from '../sleep.js'
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── Types ────────────────────────────────────────────────────────────────────

/** Coordinates from xdotool-style (logical) or physical pixels */
export interface ClickOptions {
  button?: 'left' | 'right' | 'middle'
  double?: boolean
  x: number
  y: number
}

export interface TypeOptions {
  delay?: number
}

export interface KeyOptions {
  delay?: number
}

export interface ScrollOptions {
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  x?: number
  y?: number
}

export interface ScreenshotOptions {
  display?: number
  region?: string
  output?: string
}

export interface WindowInfo {
  address: string
  title: string
  class: string
  workspace: number
  floating: boolean
  fullscreen: boolean
  pid: number
  x: number
  y: number
  w: number
  h: number
}

export interface AppInfo {
  name: string
  exec: string
  icon?: string
  categories?: string[]
}

export interface DisplayGeometry {
  width: number
  height: number
  x: number
  y: number
  scaleFactor: number
  name: string
}

export interface ScreenshotResult {
  base64: string
  mediaType: string
  width: number
  height: number
}

export interface RunningApp {
  name: string
  pid: number
  bundleId?: string
  path?: string
}

export interface FrontmostApp {
  name: string
  pid: number
  bundleId?: string
  path?: string
}

/** ComputerExecutor interface compatible with @ant/computer-use-mcp */
export interface LinuxExecutor {
  // Core input
  click(x: number, y: number, options?: { button?: 'left' | 'right' | 'middle'; double?: boolean }): Promise<void>
  type(text: string, options?: TypeOptions): Promise<void>
  key(sequence: string, options?: KeyOptions): Promise<void>
  scroll(x: number, y: number, options?: ScrollOptions): Promise<void>
  moveMouse(x: number, y: number): Promise<void>
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>

  // Screenshots
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>

  // Window/app management
  listWindows(): Promise<WindowInfo[]>
  focusWindow(selector: string): Promise<void>
  closeActive(): Promise<void>
  minimizeActive(): Promise<void>
  moveActive(x: number, y: number): Promise<void>
  resizeActive(w: number, h: number): Promise<void>
  switchWorkspace(n: number): Promise<void>
  moveToWorkspace(selector: string, n: number): Promise<void>
  toggleFloating(): Promise<void>
  toggleFullscreen(): Promise<void>
  pinActive(): Promise<void>
  launchApp(command: string): Promise<void>
  listApps(): Promise<AppInfo[]>
  getActiveWindow(): Promise<WindowInfo | null>
  listRunningApps(): Promise<RunningApp[]>
  getFrontmostApp(): Promise<FrontmostApp | null>

  // Display
  getDisplays(): Promise<DisplayGeometry[]>

  // Clipboard
  getClipboard(): Promise<string>
  setClipboard(text: string): Promise<void>

  // Permissions
  checkPermissions(): Promise<{ granted: boolean }>

  // Capabilities
  capabilities: {
    screenshotFiltering: 'native'
    platform: 'linux'
  }
}

// ── Input backend detection ──────────────────────────────────────────────────

type InputBackend = 'ydotool' | 'wtype' | 'none'

async function detectInputBackend(): Promise<InputBackend> {
  const { code: ydo } = await execFileNoThrow('which', ['ydotool'], { timeoutMs: 2_000 })
  if (ydo === 0) return 'ydotool'
  const { code: wt } = await execFileNoThrow('which', ['wtype'], { timeoutMs: 2_000 })
  if (wt === 0) return 'wtype'
  return 'none'
}

// ── Screenshot backend ───────────────────────────────────────────────────────

async function detectScreenshotBackend(): Promise<'grim' | 'spectacle' | 'none'> {
  const { code: gr } = await execFileNoThrow('which', ['grim'], { timeoutMs: 2_000 })
  if (gr === 0) return 'grim'
  return 'none'
}

// ── Key sequence parsing ─────────────────────────────────────────────────────

/** Parse xdotool-style key sequence into ydotool args */
function parseKeySequence(seq: string): string {
  const parts = seq.split('+')
  const key = parts.pop()!
  const mods = parts.map(m => m.toLowerCase())
  if (mods.length > 0) {
    return `${mods.join('+')}+${key}`
  }
  return key
}

/** Parse key sequence for wtype */
function parseKeySequenceWtype(seq: string): string[] {
  const parts = seq.split('+')
  const key = parts.pop()!
  const mods = parts.map(m => m.toLowerCase())
  const args: string[] = []
  for (const m of mods) {
    if (m === 'ctrl' || m === 'control') args.push('ctrl')
    else if (m === 'alt') args.push('alt')
    else if (m === 'shift') args.push('shift')
    else if (m === 'super' || m === 'cmd' || m === 'meta') args.push('super')
  }
  return [...args, key]
}

// ── Executor factory ─────────────────────────────────────────────────────────

async function createLinuxExecutor(): Promise<LinuxExecutor> {
  const inputBackend = await detectInputBackend()
  const screenshotBackend = await detectScreenshotBackend()

  if (inputBackend === 'none') {
    throw new Error(
      'No Wayland input tool found. Install ydotool (AUR: ydotool) or wtype (AUR: wtype). ' +
      'ydotool requires a running ydotoold daemon.',
    )
  }
  if (screenshotBackend === 'none') {
    throw new Error('No screenshot tool found. Install grim (grim package).')
  }

  const ydotool = async (args: string[]) => {
    const { code, error } = await execFileNoThrow('ydotool', args, { timeoutMs: 10_000 })
    if (code !== 0) {
      throw new Error(`ydotool ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
  }

  const wtype = async (args: string[]) => {
    const { code, error } = await execFileNoThrow('wtype', args, { timeoutMs: 10_000 })
    if (code !== 0) {
      throw new Error(`wtype ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
  }

  const sendKey = async (sequence: string) => {
    if (inputBackend === 'ydotool') {
      await ydotool(['key', parseKeySequence(sequence)])
    } else {
      await wtype(['-M', ...parseKeySequenceWtype(sequence)])
    }
  }

  const hyprctl = async (args: string[]) => {
    const { code, error } = await execFileNoThrow('hyprctl', args, { timeoutMs: 5_000 })
    if (code !== 0) {
      throw new Error(`hyprctl ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
  }

  const hyprctlJson = async <T>(args: string[]): Promise<T> => {
    const { code, stdout, error } = await execFileNoThrow('hyprctl', ['-j', ...args], { timeoutMs: 5_000 })
    if (code !== 0) {
      throw new Error(`hyprctl -j ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
    return JSON.parse(stdout) as T
  }

  const grim = async (args: string[]): Promise<string> => {
    const { code, stdout, error } = await execFileNoThrow('grim', args, { timeoutMs: 10_000 })
    if (code !== 0) {
      throw new Error(`grim ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
    return stdout
  }

  return {
    capabilities: {
      screenshotFiltering: 'native' as const,
      platform: 'linux' as const,
    },

    // Core input
    async click(x, y, options?) {
      await ydotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))])
      await sleep(50)
      const button = options?.button ?? 'left'
      const clickCount = options?.double ? 2 : 1
      for (let i = 0; i < clickCount; i++) {
        const btnCode = button === 'left' ? 1 : button === 'right' ? 3 : 2
        await ydotool(['click', String(btnCode)])
        if (i < clickCount - 1) await sleep(100)
      }
    },

    async type(text, options?) {
      const delay = options?.delay ?? 12
      await ydotool(['type', '--', text])
      await sleep(delay)
    },

    async key(sequence, options?) {
      const delay = options?.delay ?? 50
      await sendKey(sequence)
      await sleep(delay)
    },

    async scroll(x, y, options?) {
      const direction = options?.direction ?? 'down'
      const amount = options?.amount ?? 3
      await ydotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))])
      await sleep(50)
      for (let i = 0; i < amount; i++) {
        const btn = direction === 'down' ? 5 : direction === 'up' ? 4 : direction === 'left' ? 6 : 7
        await ydotool(['click', String(btn)])
        await sleep(50)
      }
    },

    async moveMouse(x, y) {
      await ydotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))])
    },

    async drag(x1, y1, x2, y2) {
      await ydotool(['mousemove', '--', String(Math.round(x1)), String(Math.round(y1))])
      await sleep(100)
      await ydotool(['click', '1']) // left down
      await sleep(100)
      await ydotool(['mousemove', '--', String(Math.round(x2)), String(Math.round(y2))])
      await sleep(100)
      await ydotool(['click', '0']) // release
    },

    // Screenshots
    async screenshot(options?: ScreenshotOptions) {
      const args: string[] = []
      if (options?.display !== undefined) {
        const displays = await this.getDisplays()
        const disp = displays[options.display]
        if (disp) args.push('-o', disp.name)
      }
      if (options?.region) args.push('-g', options.region)
      args.push('-') // stdout
      const base64 = await grim(args)

      // Get dimensions from primary display
      const displays = await this.getDisplays()
      const primary = displays[0]

      return {
        base64,
        mediaType: 'image/png',
        width: primary?.width ?? 1920,
        height: primary?.height ?? 1080,
      }
    },

    // Window management
    async listWindows() {
      return hyprctlJson<WindowInfo[]>('clients')
    },

    async focusWindow(selector) {
      await hyprctl(['dispatch', 'focuswindow', `class:${selector}`]).catch(async () => {
        await hyprctl(['dispatch', 'focuswindow', `title:${selector}`])
      })
    },

    async closeActive() {
      await hyprctl(['dispatch', 'killactive'])
    },

    async minimizeActive() {
      await hyprctl(['dispatch', 'togglefloating', 'active'])
    },

    async moveActive(x, y) {
      await hyprctl(['dispatch', 'moveactive', `${Math.round(x)} ${Math.round(y)}`])
    },

    async resizeActive(w, h) {
      await hyprctl(['dispatch', 'resizeactive', `${Math.round(w)} ${Math.round(h)}`])
    },

    async switchWorkspace(n) {
      await hyprctl(['dispatch', 'workspace', String(n)])
    },

    async moveToWorkspace(selector, n) {
      await hyprctl(['dispatch', 'movetoworkspace', `${n},class:${selector}`]).catch(async () => {
        await hyprctl(['dispatch', 'movetoworkspace', `${n},title:${selector}`])
      })
    },

    async toggleFloating() {
      await hyprctl(['dispatch', 'togglefloating'])
    },

    async toggleFullscreen() {
      await hyprctl(['dispatch', 'fullscreen'])
    },

    async pinActive() {
      await hyprctl(['dispatch', 'pin'])
    },

    // Apps
    async launchApp(command) {
      const { code } = await execFileNoThrow('sh', ['-c', `nohup ${command} >/dev/null 2>&1 &`], { timeoutMs: 5_000 })
      if (code !== 0) throw new Error(`Failed to launch: ${command}`)
      await sleep(500)
    },

    async listApps() {
      const { stdout } = await execFileNoThrow(
        'sh',
        ['-c', `grep -h "^Name=" /usr/share/applications/*.desktop 2>/dev/null | sed "s/^Name=//" | sort -u`],
        { timeoutMs: 5_000 },
      )
      const { stdout: execs } = await execFileNoThrow(
        'sh',
        ['-c', `grep -h "^Exec=" /usr/share/applications/*.desktop 2>/dev/null | sed "s/^Exec=//" | sed "s/ %[fFuUdDnNickvm]//g" | sort -u`],
        { timeoutMs: 5_000 },
      )
      const names = stdout.split('\n').filter(Boolean)
      const execsList = execs.split('\n').filter(Boolean)
      return names.slice(0, 50).map((name, i) => ({
        name,
        exec: execsList[i] ?? name.toLowerCase(),
      }))
    },

    async getActiveWindow() {
      return hyprctlJson<WindowInfo>('activewindow')
    },

    async listRunningApps() {
      const windows = await this.listWindows()
      // Deduplicate by PID
      const seen = new Set<number>()
      return windows
        .filter(w => !seen.has(w.pid) && seen.add(w.pid))
        .map(w => ({
          name: w.class,
          pid: w.pid,
          bundleId: w.class,
        }))
    },

    async getFrontmostApp() {
      const win = await this.getActiveWindow()
      if (!win) return null
      return { name: win.class, pid: win.pid, bundleId: win.class }
    },

    // Display
    async getDisplays(): Promise<DisplayGeometry[]> {
      const monitors = await hyprctlJson<Array<{
        name: string;
        x: number;
        y: number;
        width: number;
        height: number;
        scale: number;
        make?: string;
        model?: string;
      }>>('monitors')
      return monitors.map(m => ({
        name: m.name,
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        scaleFactor: m.scale,
      }))
    },

    // Clipboard
    async getClipboard() {
      const { code, stdout } = await execFileNoThrow('wl-paste', [], { timeoutMs: 2_000 })
      if (code !== 0) {
        const { code: xcode, stdout: xout } = await execFileNoThrow('xclip', ['-o', '-selection', 'clipboard'], { timeoutMs: 2_000 })
        if (xcode !== 0) throw new Error('No clipboard tool found (wl-paste or xclip)')
        return xout
      }
      return stdout
    },

    async setClipboard(text) {
      const { code } = await execFileNoThrow('wl-copy', [], { input: text, timeoutMs: 2_000 })
      if (code !== 0) {
        await execFileNoThrow('xclip', ['-selection', 'clipboard'], { input: text, timeoutMs: 2_000 })
      }
    },

    // Permissions
    async checkPermissions() {
      // Check for ydotoold socket and grim
      const { code: ydo } = await execFileNoThrow('which', ['ydotool'], { timeoutMs: 1_000 })
      const { code: gr } = await execFileNoThrow('which', ['grim'], { timeoutMs: 1_000 })
      return { granted: ydo === 0 && gr === 0 }
    },
  }
}

// Helper for hyprctl JSON
async function hyprctlJson<T>(...args: string[]): Promise<T> {
  const { code, stdout, error } = await execFileNoThrow('hyprctl', ['-j', ...args], { timeoutMs: 5_000 })
  if (code !== 0) {
    throw new Error(`hyprctl -j ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
  }
  return JSON.parse(stdout) as T
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let executorInstance: LinuxExecutor | undefined

export function getLinuxExecutor(): LinuxExecutor {
  if (!executorInstance) {
    executorInstance = await createLinuxExecutor()
  }
  return executorInstance
}

export function resetLinuxExecutor(): void {
  executorInstance = undefined
}

// ── Platform check ────────────────────────────────────────────────────────────

export function isLinuxDesktopAvailable(): boolean {
  return process.platform === 'linux' &&
    !!process.env.WAYLAND_DISPLAY &&
    process.env.HYPRLAND_INSTANCE_SIGNATURE !== undefined
}

export function isHyprland(): boolean {
  return !!process.env.HYPRLAND_INSTANCE_SIGNATURE
}

export function isWayland(): boolean {
  return !!process.env.WAYLAND_DISPLAY || !!process.env.XDG_SESSION_TYPE === 'wayland'
}

export function isX11(): boolean {
  return !!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

  /** List windows */
  listWindows(): Promise<WindowInfo[]>

  /** Focus a window by class/title */
  focusWindow(selector: string): Promise<void>

  /** Close active window */
  closeActive(): Promise<void>

  /** Minimize active window */
  minimizeActive(): Promise<void>

  /** Move active window */
  moveActive(x: number, y: number): Promise<void>

  /** Resize active window */
  resizeActive(w: number, h: number): Promise<void>

  /** Switch workspace */
  switchWorkspace(n: number): Promise<void>

  /** Move window to workspace */
  moveToWorkspace(selector: string, n: number): Promise<void>

  /** Toggle floating */
  toggleFloating(): Promise<void>

  /** Toggle fullscreen */
  toggleFullscreen(): Promise<void>

  /** Pin window (follow across workspaces) */
  pinActive(): Promise<void>

  // ── App management ──

  /** Launch application */
  launchApp(command: string): Promise<void>

  /** List installed .desktop apps */
  listApps(): Promise<AppInfo[]>

  /** Get active window info */
  getActiveWindow(): Promise<WindowInfo | null>

  // ── Clipboard ──

  getClipboard(): Promise<string>
  setClipboard(text: string): Promise<void>
}

export interface WindowInfo {
  address: string
  title: string
  class: string
  workspace: number
  floating: boolean
  fullscreen: boolean
  pid: number
  x: number
  y: number
  w: number
  h: number
}

export interface AppInfo {
  name: string
  exec: string
  icon?: string
  categories?: string[]
}

// ── Input backend detection ──────────────────────────────────────────────────

type InputBackend = 'ydotool' | 'wtype' | 'none'

async function detectInputBackend(): Promise<InputBackend> {
  const { code: ydo } = await execFileNoThrow('which', ['ydotool'], { timeoutMs: 2_000 })
  if (ydo === 0) return 'ydotool'
  const { code: wt } = await execFileNoThrow('which', ['wtype'], { timeoutMs: 2_000 })
  if (wt === 0) return 'wtype'
  return 'none'
}

// ── Screenshot backend ───────────────────────────────────────────────────────

async function detectScreenshotBackend(): Promise<'grim' | 'spectacle' | 'none'> {
  const { code: gr } = await execFileNoThrow('which', ['grim'], { timeoutMs: 2_000 })
  if (gr === 0) return 'grim'
  return 'none'
}

// ── Key sequence parsing ─────────────────────────────────────────────────────

/** Parse xdotool-style key sequence into ydotool args */
function parseKeySequence(seq: string): string[] {
  const parts = seq.split('+')
  const key = parts.pop()!
  const mods = parts.map(m => m.toLowerCase())
  const args: string[] = []
  for (const m of mods) {
    if (m === 'ctrl' || m === 'control') args.push('ctrl')
    else if (m === 'alt') args.push('alt')
    else if (m === 'shift') args.push('shift')
    else if (m === 'super' || m === 'cmd' || m === 'meta') args.push('super')
  }
  // ydotool uses --key for modifier+key combos
  if (mods.length > 0) {
    return ['key', `${mods.join('+')}+${key}`]
  }
  return ['key', key]
}

/** Parse key sequence for wtype */
function parseKeySequenceWtype(seq: string): string[] {
  const parts = seq.split('+')
  const key = parts.pop()!
  const mods = parts.map(m => m.toLowerCase())
  const args: string[] = []
  for (const m of mods) {
    if (m === 'ctrl' || m === 'control') args.push('ctrl')
    else if (m === 'alt') args.push('alt')
    else if (m === 'shift') args.push('shift')
    else if (m === 'super' || m === 'cmd' || m === 'meta') args.push('super')
  }
  return [...args, key]
}

// ── Executor ─────────────────────────────────────────────────────────────────

async function createLinuxExecutor(): Promise<LinuxExecutor> {
  const inputBackend = await detectInputBackend()
  const screenshotBackend = await detectScreenshotBackend()

  if (inputBackend === 'none') {
    throw new Error(
      'No Wayland input tool found. Install ydotool (AUR: ydotool) or wtype (AUR: wtype). ' +
      'ydotool requires a running ydotoold daemon.',
    )
  }
  if (screenshotBackend === 'none') {
    throw new Error('No screenshot tool found. Install grim (grim package).')
  }

  const ydotool = async (args: string[]) => {
    const { code, error } = await execFileNoThrow('ydotool', args, { timeoutMs: 10_000 })
    if (code !== 0) {
      throw new Error(`ydotool ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
  }

  const wtype = async (args: string[]) => {
    const { code, error } = await execFileNoThrow('wtype', args, { timeoutMs: 10_000 })
    if (code !== 0) {
      throw new Error(`wtype ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
  }

  const sendKey = async (sequence: string) => {
    if (inputBackend === 'ydotool') {
      await ydotool(['key', sequence])
    } else {
      await wtype(['-M', ...parseKeySequenceWtype(sequence)])
    }
  }

  const hyprctl = async (args: string[]) => {
    const { code, error } = await execFileNoThrow('hyprctl', args, { timeoutMs: 5_000 })
    if (code !== 0) {
      throw new Error(`hyprctl ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
  }

  const grim = async (args: string[]): Promise<string> => {
    const { code, stdout, error } = await execFileNoThrow('grim', args, { timeoutMs: 10_000 })
    if (code !== 0) {
      throw new Error(`grim ${args.join(' ')} failed: ${error ?? `exit ${code}`}`)
    }
    return stdout
  }

  return {
    async screenshot(options?: { region?: string; output?: string }) {
      const args: string[] = []
      if (options?.region) args.push('-g', options.region)
      args.push('-') // stdout
      const base64 = await grim(args)

      // Get dimensions via hyprctl
      const { stdout: monitors } = await execFileNoThrow('hyprctl', ['monitors', '-j'], { timeoutMs: 5_000 })
      const monList = JSON.parse(monitors) as Array<{ x: number; y: number; width: number; height: number }>
      const active = monList.find(m => m.x === 0 && m.y === 0) ?? monList[0]

      return {
        base64,
        mediaType: 'image/png',
        width: active?.width ?? 1920,
        height: active?.height ?? 1080,
      }
    },

    async click(x, y, options?) {
      await ydotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))])
      await sleep(50)
      const button = options?.button ?? 'left'
      const clickCount = options?.double ? 2 : 1
      for (let i = 0; i < clickCount; i++) {
        const btnCode = button === 'left' ? 1 : button === 'right' ? 3 : 2
        await ydotool(['click', String(btnCode)])
        if (i < clickCount - 1) await sleep(100)
      }
    },

    async type(text, options?) {
      const delay = options?.delay ?? 12
      // ydotool type
      await ydotool(['type', '--', text])
      await sleep(delay)
    },

    async key(sequence, options?) {
      const delay = options?.delay ?? 50
      await sendKey(sequence)
      await sleep(delay)
    },

    async scroll(x, y, options?) {
      const direction = options?.direction ?? 'down'
      const amount = options?.amount ?? 3
      await ydotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))])
      await sleep(50)
      for (let i = 0; i < amount; i++) {
        const btn = direction === 'down' ? 5 : direction === 'up' ? 4 : direction === 'left' ? 6 : 7
        await ydotool(['click', String(btn)])
        await sleep(50)
      }
    },

    async moveMouse(x, y) {
      await ydotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))])
    },

    async drag(x1, y1, x2, y2) {
      await ydotool(['mousemove', '--', String(Math.round(x1)), String(Math.round(y1))])
      await sleep(100)
      await ydotool(['click', '1']) // left down
      await sleep(100)
      await ydotool(['mousemove', '--', String(Math.round(x2)), String(Math.round(y2))])
      await sleep(100)
      await ydotool(['click', '0']) // release
    },

    async listWindows() {
      const { stdout } = await execFileNoThrow('hyprctl', ['clients', '-j'], { timeoutMs: 5_000 })
      const clients = JSON.parse(stdout) as Array<{
        address: string
        title: string
        class: string
        workspace: { id: number }
        floating: boolean
        fullscreen: boolean
        pid: number
        at: [number, number]
        size: [number, number]
      }>
      return clients.map(c => ({
        address: c.address,
        title: c.title,
        class: c.class,
        workspace: c.workspace.id,
        floating: c.floating,
        fullscreen: c.fullscreen,
        pid: c.pid,
        x: c.at[0],
        y: c.at[1],
        w: c.size[0],
        h: c.size[1],
      }))
    },

    async focusWindow(selector) {
      // Try by class, then title
      await hyprctl(['dispatch', 'focuswindow', `class:${selector}`]).catch(async () => {
        await hyprctl(['dispatch', 'focuswindow', `title:${selector}`])
      })
    },

    async closeActive() {
      await hyprctl(['dispatch', 'activewindow'])
      await hyprctl(['dispatch', 'killactive'])
    },

    async minimizeActive() {
      await hyprctl(['dispatch', 'togglefloating', 'active'])
    },

    async moveActive(x, y) {
      await hyprctl(['dispatch', 'moveactive', `${Math.round(x)} ${Math.round(y)}`])
    },

    async resizeActive(w, h) {
      await hyprctl(['dispatch', 'resizeactive', `${Math.round(w)} ${Math.round(h)}`])
    },

    async switchWorkspace(n) {
      await hyprctl(['dispatch', 'workspace', String(n)])
    },

    async moveToWorkspace(selector, n) {
      await hyprctl(['dispatch', 'movetoworkspace', `${n},class:${selector}`]).catch(async () => {
        await hyprctl(['dispatch', 'movetoworkspace', `${n},title:${selector}`])
      })
    },

    async toggleFloating() {
      await hyprctl(['dispatch', 'togglefloating'])
    },

    async toggleFullscreen() {
      await hyprctl(['dispatch', 'fullscreen'])
    },

    async pinActive() {
      await hyprctl(['dispatch', 'pin'])
    },

    async launchApp(command) {
      // Detach process
      const { code } = await execFileNoThrow('sh', ['-c', `nohup ${command} >/dev/null 2>&1 &`], { timeoutMs: 5_000 })
      if (code !== 0) {
        throw new Error(`Failed to launch: ${command}`)
      }
      await sleep(500)
    },

    async listApps() {
      // Parse .desktop files
      const { stdout } = await execFileNoThrow(
        'sh',
        ['-c', `grep -h "^Name=" /usr/share/applications/*.desktop 2>/dev/null | sed "s/^Name=//" | sort -u`],
        { timeoutMs: 5_000 },
      )
      const { stdout: execs } = await execFileNoThrow(
        'sh',
        ['-c', `grep -h "^Exec=" /usr/share/applications/*.desktop 2>/dev/null | sed "s/^Exec=//" | sed "s/ %[fFuUdDnNickvm]//g" | sort -u`],
        { timeoutMs: 5_000 },
      )
      const names = stdout.split('\n').filter(Boolean)
      const execsList = execs.split('\n').filter(Boolean)
      return names.slice(0, 50).map((name, i) => ({
        name,
        exec: execsList[i] ?? name.toLowerCase(),
      }))
    },

    async getActiveWindow() {
      const { stdout } = await execFileNoThrow('hyprctl', ['activewindow', '-j'], { timeoutMs: 5_000 })
      const win = JSON.parse(stdout) as {
        title: string
        class: string
        workspace: { id: number }
        floating: boolean
        fullscreen: boolean
        pid: number
        at: [number, number]
        size: [number, number]
      }
      return {
        address: '',
        title: win.title,
        class: win.class,
        workspace: win.workspace.id,
        floating: win.floating,
        fullscreen: win.fullscreen,
        pid: win.pid,
        x: win.at[0],
        y: win.at[1],
        w: win.size[0],
        h: win.size[1],
      }
    },

    async getClipboard() {
      // Wayland: wl-paste
      const { code, stdout } = await execFileNoThrow('wl-paste', [], { timeoutMs: 2_000 })
      if (code !== 0) {
        // X11 fallback
        const { code: xcode, stdout: xout } = await execFileNoThrow('xclip', ['-o', '-selection', 'clipboard'], { timeoutMs: 2_000 })
        if (xcode !== 0) throw new Error('No clipboard tool found (wl-paste or xclip)')
        return xout
      }
      return stdout
    },

    async setClipboard(text) {
      const { code } = await execFileNoThrow('wl-copy', [], { input: text, timeoutMs: 2_000 })
      if (code !== 0) {
        await execFileNoThrow('xclip', ['-selection', 'clipboard'], { input: text, timeoutMs: 2_000 })
      }
    },
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let executorInstance: LinuxExecutor | undefined

export function getLinuxExecutor(): LinuxExecutor {
  if (!executorInstance) {
    executorInstance = await createLinuxExecutor()
  }
  return executorInstance
}

export function resetLinuxExecutor(): void {
  executorInstance = undefined
}

// ── Platform check ────────────────────────────────────────────────────────────

export function isLinuxDesktopAvailable(): boolean {
  return process.platform === 'linux' &&
    !!process.env.WAYLAND_DISPLAY &&
    process.env.HYPRLAND_INSTANCE_SIGNATURE !== undefined
}

export function isHyprland(): boolean {
  return !!process.env.HYPRLAND_INSTANCE_SIGNATURE
}

export function isWayland(): boolean {
  return !!process.env.WAYLAND_DISPLAY || !!process.env.XDG_SESSION_TYPE === 'wayland'
}

export function isX11(): boolean {
  return !!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}