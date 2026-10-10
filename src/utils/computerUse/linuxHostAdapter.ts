/**
 * Linux/Hyprland HostAdapter for @ant/computer-use-mcp
 *
 * Mirrors the macOS hostAdapter.ts but uses LinuxExecutor instead of
 * the macOS native modules.
 */

import type {
  ComputerUseHostAdapter,
  Logger,
} from '@ant/computer-use-mcp/types'
import { format } from 'util'
import { logForDebugging } from '../debug.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { getLinuxExecutor, isLinuxDesktopAvailable, isHyprland } from './linuxExecutor.js'

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
 * Process-lifetime singleton for Linux/Hyprland.
 * Built once on first CU tool call; loads LinuxExecutor via grim/hyprctl/ydotool.
 */
export function getLinuxComputerUseHostAdapter(): ComputerUseHostAdapter {
  if (cached) return cached

  // Check platform first
  if (!isLinuxDesktopAvailable()) {
    throw new Error(
      'Linux desktop control requires: Linux platform + Wayland + Hyprland. ' +
      'Set WAYLAND_DISPLAY and ensure HYPRLAND_INSTANCE_SIGNATURE is set.'
    )
  }

  const executor = getLinuxExecutor()

  cached = {
    serverName: COMPUTER_USE_MCP_SERVER_NAME,
    logger: new DebugLogger(),
    executor,
    ensureOsPermissions: async () => {
      const perms = await executor.checkPermissions()
      return perms
    },
    isDisabled: () => !isLinuxDesktopAvailable(),
    getSubGates: () => ({
      mouseAnimation: true,
      hideBeforeAction: false,
      autoTargetDisplay: true,
      clipboardGuard: true,
      coordinateMode: 'logical' as const,
    }),
    getAutoUnhideEnabled: () => false, // Not applicable on Linux
    cropRawPatch: () => null,
  }
  return cached
}

export function resetLinuxComputerUseHostAdapter(): void {
  cached = undefined
}