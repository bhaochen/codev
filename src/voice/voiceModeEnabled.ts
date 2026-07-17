/**
 * Kill-switch check for voice mode. Bypassed in external builds —
 * voice is always eligible pending other checks (mic, dependencies,
 * STT backend).
 */
export function isVoiceGrowthBookEnabled(): boolean {
  return true
}

/**
 * Auth-only check for voice mode. Returns true unconditionally in
 * external builds — the Groq Whisper backend does not require Anthropic
 * OAuth, and the GrowthBook kill-switch is already bypassed.
 */
export function hasVoiceAuth(): boolean {
  return true
}

/**
 * Full runtime check for voice mode.
 * Returns true when both auth + GrowthBook kill-switch pass.
 */
export function isVoiceModeEnabled(): boolean {
  return hasVoiceAuth() && isVoiceGrowthBookEnabled()
}

/**
 * Check if voice mode can be activated with the Groq STT backend.
 * The Groq backend does not require Anthropic auth.
 */
export function isVoiceAvailable(): boolean {
  return isVoiceGrowthBookEnabled()
}