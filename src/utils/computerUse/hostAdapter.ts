import type {
  ComputerUseHostAdapter,
  Logger,
} from '@ant/computer-use-mcp/types'
import { format } from 'util'
import { logForDebugging } from '../debug.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { createCliExecutor } from './executor.js'
import { getChicagoEnabled, getChicagoSubGates } from './gates.js'
import { requireComputerUseSwift } from './swiftLoader.js'
import { getLinuxExecutor, isLinuxDesktopAvailable, isHyprland } from './linuxExecutor.js'
import { getLinuxComputerUseHostAdapter } from './linuxHostAdapter.js'

class DebugLogger implements Logger {
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}

let cached: ComputerUseHostAdapter | undefined

/**
 * Process-lifetime singleton. Built once on first CU tool call; native modules
 * (both `@ant/computer-use-input` and `@ant/computer-use-swift`) are loaded
 * here via the executor factory, which throws on load failure — there is no
 * degraded mode.
 *
 * Platform detection:
 * - macOS: uses macOS native modules (Swift, enigo)
 * - Linux/Hyprland: uses grim, hyprctl, ydotool/wtype
 * - Other: throws
 */
export function getComputerUseHostAdapter(): ComputerUseHostAdapter {
  if (cached) return cached

  // Linux/Hyprland
  if (isLinuxDesktopAvailable() || isHyprland()) {
    cached = getLinuxComputerUseHostAdapter()
    return cached
  }

  // macOS
  if (process.platform === 'darwin') {
    cached = {
      serverName: COMPUTER_USE_MCP_SERVER_NAME,
      logger: new DebugLogger(),
      executor: createCliExecutor({
        getMouseAnimationEnabled: () => getChicagoSubGates().mouseAnimation,
        getHideBeforeActionEnabled: () => getChicagoSubGates().hideBeforeAction,
      }),
      ensureOsPermissions: async () => {
        const cu = requireComputerUseSwift()
        const accessibility = cu.tcc.checkAccessibility()
        const screenRecording = cu.tcc.checkScreenRecording()
        return accessibility && screenRecording
          ? { granted: true }
          : { granted: false, accessibility, screenRecording }
      },
      isDisabled: () => !getChicagoEnabled(),
      getSubGates: getChicagoSubGates,
      // cleanup.ts always unhides at turn end — no user preference to disable it.
      getAutoUnhideEnabled: () => true,

      // Pixel-validation JPEG decode+crop. MUST be synchronous (the package
      // does `patch1.equals(patch2)` directly on the return value). Cowork uses
      // Electron's `nativeImage` (sync); our `image-processor-napi` is
      // sharp-compatible and async-only. Returning null → validation skipped,
      // click proceeds — the designed fallback per `PixelCompareResult.skipped`.
      // The sub-gate defaults to false anyway.
      cropRawPatch: () => null,
    }
    return cached
  }

  throw new Error(
    `Computer Use is not supported on ${process.platform}. ` +
    'Supported: macOS (Accessibility + Screen Recording) and Linux/Hyprland (Wayland + grim + hyprctl + ydotool/wtype).'
  )
}

export function resetComputerUseHostAdapter(): void {
  cached = undefined
}
