/**
 * Reads and writes for the automatic-compaction controls.
 *
 * Split from `compactionSettings.ts` so the threshold arithmetic there stays
 * dependency-free and directly testable; this file is the only part that
 * touches global config.
 */

import { getGlobalConfig, saveGlobalConfig } from './config.js'
import {
  isValidThresholdPercent,
  isValidWindowCap,
  normalizeThresholdPercent,
} from './compactionSettings.js'

/** Configured threshold percentage, or undefined for auto. */
export function getConfiguredThresholdPercent(): number | undefined {
  const value = getGlobalConfig().autoCompactThresholdPercent
  return isValidThresholdPercent(value) ? value : undefined
}

/** Configured context ceiling in tokens, or undefined for none. */
export function getConfiguredWindowCap(): number | undefined {
  const value = getGlobalConfig().autoCompactWindowCap
  return isValidWindowCap(value) ? value : undefined
}

/** Persist a threshold percentage (normalized), or clear it with undefined. */
export function setConfiguredThresholdPercent(
  percent: number | undefined,
): void {
  saveGlobalConfig(config => ({
    ...config,
    autoCompactThresholdPercent:
      percent === undefined ? undefined : normalizeThresholdPercent(percent),
  }))
}

/** Persist a context ceiling, or clear it with undefined. Invalid values clear. */
export function setConfiguredWindowCap(tokens: number | undefined): void {
  saveGlobalConfig(config => ({
    ...config,
    autoCompactWindowCap: isValidWindowCap(tokens) ? tokens : undefined,
  }))
}
