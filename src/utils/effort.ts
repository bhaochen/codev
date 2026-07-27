// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { MODEL_EFFORT_CONFIGS_ENV_KEY } from './model/modelContextWindows.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

/**
 * Per-model effort configuration, defining supported effort levels
 * and the mapping from generic effort levels to provider wire values.
 */
export interface ModelEffortConfig {
  levels: EffortLevel[]
  defaultLevel?: EffortLevel
  /**
   * Maps generic effort levels to provider wire values.
   * Key is the generic EffortLevel, value is the wire format (e.g. 'low' for Anthropic).
   * The wire value may differ from the key (e.g. 'xhigh' → 'max').
   */
  wireMap?: Partial<Record<EffortLevel, string>>
}

// Default Anthropic API wire mapping for extended effort levels.
// Anthropic output_config.effort supports: low, medium, high, max
export const ANTHROPIC_EFFORT_WIRE_MAP: Record<EffortLevel, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Check dynamic model effort config from provider presets
  const configs = resolveModelEffortConfigs()
  const canonical = getCanonicalName(model)
  if (configs[canonical]?.levels) return true
  for (const [key, config] of Object.entries(configs)) {
    if ((canonical.startsWith(key) || canonical.includes(key)) && config.levels) {
      return true
    }
  }
  // Supported by a subset of Claude 4 models
  if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return true
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // 3P providers with models.dev data — enable effort only for models that
  // have explicit reasoning_options in the cache.
  const provider = getAPIProvider()
  if (provider === 'nvidia') {
    const { getNvidiaModelReasoningOptions } = require('../services/api/nvidiaClient.js') as {
      getNvidiaModelReasoningOptions: (id: string) => string[] | undefined
    }
    const opts = getNvidiaModelReasoningOptions(canonical)
    if (opts && opts.length > 0) return true
    return false
  }
  if (provider === 'opencode') {
    const { getOpencodeModelReasoningOptions } = require('../services/api/opencodeClient.js') as {
      getOpencodeModelReasoningOptions: (id: string) => string[] | undefined
    }
    const opts = getOpencodeModelReasoningOptions(canonical)
    if (opts && opts.length > 0) return true
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return provider === 'firstParty'
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
// Per API docs, 'max' is Opus 4.6 only for public models — other models return an error.
export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Check dynamic model effort config from provider presets
  const supported = getModelSupportedEfforts(model)
  if (supported.includes('max')) return true
  if (model.toLowerCase().includes('opus-4-6')) {
    return true
  }
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) {
    return true
  }
  return false
}

/**
 * Resolve per-model effort configuration, merging:
 * 1. ~/.claude/settings.json modelEffortConfigs (user settings)
 * 2. CLAUDE_CODE_MODEL_EFFORT_CONFIGS env var
 * Settings take precedence over env var.
 */
function resolveModelEffortConfigs(): Record<string, ModelEffortConfig> {
  const configs: Record<string, ModelEffortConfig> = {}

  // 1. Env var (lower priority)
  const raw = process.env[MODEL_EFFORT_CONFIGS_ENV_KEY]
  if (raw) {
    try {
      Object.assign(configs, JSON.parse(raw))
    } catch {
      // Invalid JSON, ignore
    }
  }

  // 2. Settings (higher priority, overrides env var)
  const settingsConfigs = getInitialSettings().modelEffortConfigs
  if (settingsConfigs) {
    for (const [key, value] of Object.entries(settingsConfigs)) {
      configs[key] = value as ModelEffortConfig
    }
  }

  return configs
}

/**
 * Check if a model name suggests it supports 'max' effort (static heuristic,
 * used as fallback when no dynamic config is available).
 */
function modelNameSupportsMax(model: string): boolean {
  const m = model.toLowerCase()
  if (m.includes('opus-4-6')) return true
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) return true
  return false
}

/**
 * Get supported effort levels for a given model.
 * Checks: 1) model-specific config from env, 2) model id prefix matching,
 * 3) falls back to default levels (minus 'max' for non-Opus models).
 */
export function getModelSupportedEfforts(model: string): EffortLevel[] {
  const configs = resolveModelEffortConfigs()
  const canonical = getCanonicalName(model)

  // 1. Exact match from config
  if (configs[canonical]?.levels) {
    return configs[canonical].levels
  }
  // 2. Prefix match from config
  for (const [key, config] of Object.entries(configs)) {
    if (canonical.startsWith(key) || canonical.includes(key)) {
      if (config.levels) return config.levels
    }
  }

  // 3. Provider-specific reasoning_options from models.dev cache
  if (getAPIProvider() === 'nvidia') {
    const { getNvidiaModelReasoningOptions } = require('../services/api/nvidiaClient.js') as {
      getNvidiaModelReasoningOptions: (id: string) => string[] | undefined
    }
    const nvOpts = getNvidiaModelReasoningOptions(canonical)
    if (nvOpts && nvOpts.length > 0) {
      const supported = nvOpts.filter((o): o is EffortLevel =>
        (EFFORT_LEVELS as readonly string[]).includes(o),
      )
      if (supported.length > 0) return supported
    }
  }

  if (getAPIProvider() === 'opencode') {
    const { getOpencodeModelReasoningOptions } = require('../services/api/opencodeClient.js') as {
      getOpencodeModelReasoningOptions: (id: string) => string[] | undefined
    }
    const ocOpts = getOpencodeModelReasoningOptions(canonical)
    if (ocOpts && ocOpts.length > 0) {
      const supported = ocOpts.filter((o): o is EffortLevel =>
        (EFFORT_LEVELS as readonly string[]).includes(o),
      )
      if (supported.length > 0) return supported
    }
  }

  // 4. Fallback: default to all levels minus 'max' for non-Opus models
  if (modelNameSupportsMax(model)) {
    return [...EFFORT_LEVELS]
  }
  return EFFORT_LEVELS.filter((l) => l !== 'max')
}

/**
 * Get the default effort level for a model from config, if any.
 */
export function getModelDefaultEffortLevel(
  model: string,
): EffortLevel | undefined {
  const configs = resolveModelEffortConfigs()
  const canonical = getCanonicalName(model)

  if (configs[canonical]?.defaultLevel) {
    return configs[canonical].defaultLevel
  }
  for (const [key, config] of Object.entries(configs)) {
    if (canonical.startsWith(key) || canonical.includes(key)) {
      if (config.defaultLevel) return config.defaultLevel
    }
  }
  return undefined
}

/**
 * Clamp a requested effort value to the model's supported range.
 * If the requested effort is not supported, finds the nearest supported level.
 */
export function clampEffortForModel(
  model: string,
  effort: EffortValue | undefined,
): EffortValue | undefined {
  if (effort === undefined || typeof effort === 'number') {
    return effort
  }
  const supported = getModelSupportedEfforts(model)
  if (supported.includes(effort)) {
    return effort
  }
  // Find the highest supported effort that does not exceed the requested level
  const requestedIndex = EFFORT_LEVELS.indexOf(effort)
  if (requestedIndex === -1) return effort
  let clamped: EffortLevel | undefined
  for (const level of supported) {
    const levelIndex = EFFORT_LEVELS.indexOf(level)
    if (levelIndex > requestedIndex) break
    clamped = level
  }
  return clamped ?? supported[0]
}

/**
 * Map an extended effort level (minimal/low/medium/high/xhigh/max) to the
 * provider's wire value. Uses model-specific wireMap if available, otherwise
 * falls back to the default Anthropic mapping.
 */
export function mapEffortToWireValue(
  model: string,
  effort: EffortValue | undefined,
): string | undefined {
  if (effort === undefined || typeof effort === 'number') return undefined

  const configs = resolveModelEffortConfigs()
  const canonical = getCanonicalName(model)

  // Check model-specific wireMap
  const findWireMap = (): Partial<Record<EffortLevel, string>> | undefined => {
    if (configs[canonical]?.wireMap) return configs[canonical].wireMap
    for (const [key, config] of Object.entries(configs)) {
      if (
        (canonical.startsWith(key) || canonical.includes(key)) &&
        config.wireMap
      ) {
        return config.wireMap
      }
    }
    return undefined
  }

  const wireMap = findWireMap()
  if (wireMap?.[effort]) return wireMap[effort]

  // Fallback to default Anthropic mapping
  return ANTHROPIC_EFFORT_WIRE_MAP[effort] ?? effort
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort filters 'max' for non-ants on read, so a manually
  // edited settings.json doesn't leak session-scoped max into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // Clamp to model's supported effort range (handles max→high downgrade
  // and other unsupported levels dynamically via model config).
  if (typeof resolved === 'string') {
    return clampEffortForModel(model, resolved)
  }
  return resolved
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 30) return 'minimal'
    if (value <= 50) return 'low'
    if (value <= 70) return 'medium'
    if (value <= 85) return 'high'
    if (value <= 100) return 'xhigh'
    return 'max'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'minimal':
      return 'Minimal thinking — fastest responses for simple tasks'
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Extra high effort — deeper reasoning for complex tasks'
    case 'max':
      return 'Maximum capability with deepest reasoning (supported models only)'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  // Default effort on Opus 4.6 to medium for Pro.
  // Max/Team also get medium when the tengu_grey_step2 config is enabled.
  if (model.toLowerCase().includes('opus-4-6')) {
    if (isProSubscriber()) {
      return 'medium'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'medium'
    }
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}
