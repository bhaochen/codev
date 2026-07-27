export function normalizeLegacyDeepSeekManagedEnv(
  env: Record<string, string>,
): { env: Record<string, string>; changed: boolean } {
  // Migrate legacy CC_HAHA_SEND_DISABLED_THINKING → ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES
  if (env.CC_HAHA_SEND_DISABLED_THINKING === '1') {
    const capabilities = 'thinking,effort,adaptive_thinking,max_effort'
    const { CC_HAHA_SEND_DISABLED_THINKING: _, ...rest } = env
    return {
      env: {
        ...rest,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: capabilities,
        ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: capabilities,
        ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: capabilities,
      },
      changed: true,
    }
  }
  return { env, changed: false }
}
