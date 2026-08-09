/**
 * Anthropic 模型名 → OpenAI 模型名的默认映射。
 * 仅在相关 env 未设置时使用。
 */
const DEFAULT_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': 'gpt-4o',
  'claude-sonnet-4-5-20250929': 'gpt-4o',
  'claude-sonnet-4-6': 'gpt-4o',
  'claude-opus-4-20250514': 'o3',
  'claude-opus-4-1-20250805': 'o3',
  'claude-opus-4-5-20251101': 'o3',
  'claude-opus-4-6': 'o3',
  'claude-haiku-4-5-20251001': 'gpt-4o-mini',
  'claude-3-5-haiku-20241022': 'gpt-4o-mini',
  'claude-3-7-sonnet-20250219': 'gpt-4o',
  'claude-3-5-sonnet-20241022': 'gpt-4o',
}

function getModelFamily(model: string): 'haiku' | 'sonnet' | 'opus' | null {
  if (/haiku/i.test(model)) return 'haiku'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return null
}

/**
 * 解析给定 Anthropic 模型对应的 OpenAI 模型名。
 *
 * 优先级：
 * 1. OPENAI_MODEL env（覆盖一切）
 * 2. OPENAI_DEFAULT_{FAMILY}_MODEL env（如 OPENAI_DEFAULT_SONNET_MODEL）
 * 3. ANTHROPIC_DEFAULT_{FAMILY}_MODEL env（向后兼容）
 * 4. DEFAULT_MODEL_MAP 查找
 * 5. 原样透传
 */
export function resolveOpenAIModel(anthropicModel: string): string {
  if (process.env.OPENAI_MODEL) {
    return process.env.OPENAI_MODEL
  }

  const cleanModel = anthropicModel.replace(/\[1m\]$/, '')

  const family = getModelFamily(cleanModel)
  if (family) {
    const openaiEnvVar = `OPENAI_DEFAULT_${family.toUpperCase()}_MODEL`
    const openaiOverride = process.env[openaiEnvVar]
    if (openaiOverride) return openaiOverride

    const anthropicEnvVar = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
    const anthropicOverride = process.env[anthropicEnvVar]
    if (anthropicOverride) return anthropicOverride
  }

  return DEFAULT_MODEL_MAP[cleanModel] ?? cleanModel
}