import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from 'src/bootstrap/state.js'
import { logError } from '../log.js'
import { sequential } from '../sequential.js'
import { getInitialSettings } from '../settings/settings.js'
import { findFirstMatch, getBedrockInferenceProfiles } from './bedrock.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type CanonicalModelId,
  type ModelKey,
} from './configs.js'
import { type APIProvider, getAPIProvider } from './providers.js'

/**
 * Maps each model version to its provider-specific model ID string.
 * Derived from ALL_MODEL_CONFIGS — adding a model there extends this type.
 */
export type ModelStrings = Record<ModelKey, string>

const MODEL_KEYS = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]

function getBuiltinModelStrings(provider: APIProvider): ModelStrings {
  if (provider === 'openai') {
    const out = getBuiltinModelStrings('firstParty') as Record<string, string>
    out.haiku45 = process.env.OPENAI_HAIKU_MODEL || 'gpt-5.4-mini'
    out.sonnet46 = process.env.OPENAI_SONNET_MODEL || 'gpt-5.4'
    out.opus46 = process.env.OPENAI_OPUS_MODEL || 'gpt-5.4'
    return out as ModelStrings
  }

  if (provider === 'opencode') {
    const out = getBuiltinModelStrings('firstParty') as Record<string, string>
    out.haiku45 = process.env.OPENCODE_HAIKU_MODEL || 'gpt-5-nano'
    out.sonnet46 = process.env.OPENCODE_SONNET_MODEL || 'big-pickle'
    out.opus46 = process.env.OPENCODE_OPUS_MODEL || 'big-pickle'
    return out as ModelStrings
  }

  if (provider === 'openrouter') {
    const out = getBuiltinModelStrings('firstParty') as Record<string, string>
    out.sonnet46 =
      process.env.OPENROUTER_SONNET_MODEL || 'anthropic/claude-sonnet-4.6'
    out.opus46 =
      process.env.OPENROUTER_OPUS_MODEL || 'anthropic/claude-opus-4.6'
    out.haiku45 =
      process.env.OPENROUTER_HAIKU_MODEL || 'anthropic/claude-haiku-4.5'
    return out as ModelStrings
  }

  if (provider === 'nvidia') {
    const out = getBuiltinModelStrings('firstParty') as Record<string, string>
    out.haiku45 = process.env.NVIDIA_HAIKU_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
    out.sonnet45 = process.env.NVIDIA_SONNET_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
    out.sonnet46 = process.env.NVIDIA_SONNET_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
    out.opus46 = process.env.NVIDIA_OPUS_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
    return out as ModelStrings
  }

  if (provider === 'local') {
    return getBuiltinModelStrings('firstParty') as ModelStrings
  }

  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = ALL_MODEL_CONFIGS[key][provider]
  }
  return out
}

async function getBedrockModelStrings(): Promise<ModelStrings> {
  const fallback = getBuiltinModelStrings('bedrock')
  let profiles: string[] | undefined
  try {
    profiles = await getBedrockInferenceProfiles()
  } catch (error) {
    logError(error as Error)
    return fallback
  }
  if (!profiles?.length) {
    return fallback
  }
  // Each config's firstParty ID is the canonical substring we search for in the
  // user's inference profile list (e.g. "claude-opus-4-6" matches
  // "eu.anthropic.claude-opus-4-6-v1"). Fall back to the hardcoded bedrock ID
  // when no matching profile is found.
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    const needle = ALL_MODEL_CONFIGS[key].firstParty
    out[key] = findFirstMatch(profiles, needle) || fallback[key]
  }
  return out
}

/**
 * Layer user-configured modelOverrides (from settings.json) on top of the
 * provider-derived model strings. Overrides are keyed by canonical first-party
 * model ID (e.g. "claude-opus-4-6") and map to arbitrary provider-specific
 * strings — typically Bedrock inference profile ARNs.
 */
function applyModelOverrides(ms: ModelStrings): ModelStrings {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) {
    return ms
  }
  const out = { ...ms }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId as CanonicalModelId]
    if (key && override) {
      out[key] = override
    }
  }
  return out
}

/**
 * Resolve an overridden model ID (e.g. a Bedrock ARN) back to its canonical
 * first-party model ID. If the input doesn't match any current override value,
 * it is returned unchanged. Safe to call during module init (no-ops if settings
 * aren't loaded yet).
 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) {
    return modelId
  }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) {
      return canonicalId
    }
  }
  return modelId
}

const updateBedrockModelStrings = sequential(async () => {
  if (getModelStringsState() !== null) {
    // Already initialized. Doing the check here, combined with
    // `sequential`, allows the test suite to reset the state
    // between tests while still preventing multiple API calls
    // in production.
    return
  }
  try {
    const ms = await getBedrockModelStrings()
    setModelStringsState(ms)
  } catch (error) {
    logError(error as Error)
  }
})

function initModelStrings(): void {
  const ms = getModelStringsState()
  if (ms !== null) {
    // Already initialized
    return
  }
  // Initial with default values for non-Bedrock providers
  if (getAPIProvider() !== 'bedrock') {
    setModelStringsState(getBuiltinModelStrings(getAPIProvider()))
    return
  }
  // On Bedrock, update model strings in the background without blocking.
  // Don't set the state in this case so that we can use `sequential` on
  // `updateBedrockModelStrings` and check for existing state on multiple
  // calls.
  void updateBedrockModelStrings()
}

export function getModelStrings(): ModelStrings {
  const ms = getModelStringsState()
  if (ms === null) {
    initModelStrings()
    // Bedrock path falls through here while the profile fetch runs in the
    // background — still honor overrides on the interim defaults.
    return applyModelOverrides(getBuiltinModelStrings(getAPIProvider()))
  }
  return applyModelOverrides(ms)
}

/**
 * Ensure model strings are fully initialized.
 * For Bedrock users, this waits for the profile fetch to complete.
 * Call this before generating model options to ensure correct region strings.
 */
export async function ensureModelStringsInitialized(): Promise<void> {
  const ms = getModelStringsState()
  if (ms !== null) {
    return
  }

  // For non-Bedrock, initialize synchronously
  if (getAPIProvider() !== 'bedrock') {
    setModelStringsState(getBuiltinModelStrings(getAPIProvider()))
    return
  }

  // For Bedrock, wait for the profile fetch
  await updateBedrockModelStrings()
}

/**
 * Clear cached model strings so the next call to getModelStrings()
 * re-initializes from the current provider. Call this after changing
 * the auth provider (e.g., after /login).
 */
export function clearModelStrings(): void {
  setModelStringsState(null as unknown as ModelStrings)
}
