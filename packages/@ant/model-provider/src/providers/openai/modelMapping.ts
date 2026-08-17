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

/**
 * 已知不支持图像输入的模型家族（收到 image_url 内容块会被上游以
 * `unknown variant `image_url`, expected `text`` 400 拒绝）：
 * - o1 / o3 系列：OpenAI 推理模型不接收图像
 * - deepseek-chat / reasoner / v3 / v4：DeepSeek 平台纯文本
 */
const TEXT_ONLY_MODEL_RE =
  /(?:^|[-./])o[13](?:[-.:]|$)|^deepseek-(chat|reasoner|v3|v4)/i

/**
 * 已知接受图像输入的模型家族（快路径，优先于 models.dev —— 后者数据不全准，
 * 例如 `openai/o4-mini` 实际支持图像却标成 text-only）。
 */
const VISION_MODEL_RE = /gpt-4o|gpt-4\.5|gpt-4\.1|gpt-5|o4-mini|chatgpt-4o/i

/** models.dev：https://models.dev/api.json（3.9MB / 6688 模型） */
const MODELS_DEV_URL = 'https://models.dev/api.json'

function forcedTextOnlyPatterns(): string[] {
  return (process.env.OPENAI_TEXT_ONLY_MODELS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 快路径判定：env 强制 + 内置名单。返回 undefined 表示需要查 models.dev。
 */
function fastPathSupportsImages(model: string): boolean | undefined {
  if (!model) return true
  const lower = model.toLowerCase()
  if (forcedTextOnlyPatterns().some(p => lower.includes(p))) return false
  if (VISION_MODEL_RE.test(lower)) return true
  if (TEXT_ONLY_MODEL_RE.test(lower)) return false
  return undefined
}

/**
 * 判断目标 OpenAI 模型是否接受图像输入（vision）。
 *
 * 纯文本模型收到 image_url 内容块会触发上游 400（serde 反序列化失败）：
 * `unknown variant `image_url`, expected `text``。转换层（openaiConvertMessages /
 * anthropicToOpenaiChat）在模型不支持视觉时应丢弃 image 块而非转成 image_url。
 *
 * 判定优先级：OPENAI_TEXT_ONLY_MODELS 环境变量（强制文本-only）> 内置名单 >
 * 默认允许（未知模型保持发图，兼容自定义端点 / 第三方视觉模型）。
 */
export function openAIModelSupportsImages(model: string): boolean {
  return fastPathSupportsImages(model) ?? true
}

// ── models.dev 查询（广覆盖准确判定）────────────────────────────

/** models.dev 中 model id → modalities.input。单例 promise 防并发重复拉取。 */
let modelsDevInputsPromise: Promise<Map<string, string[]> | null> | null = null

async function fetchModelsDevInputs(): Promise<Map<string, string[]> | null> {
  try {
    const res = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<
      string,
      { models?: Record<string, { modalities?: { input?: string[] } }> }
    >
    const map = new Map<string, string[]>()
    for (const org of Object.values(data)) {
      for (const [id, m] of Object.entries(org.models ?? {})) {
        map.set(id, m.modalities?.input ?? [])
      }
    }
    return map
  } catch {
    return null // 网络失败 → 回退快路径，绝不因查询失败而报错
  }
}

function getModelsDevInputs(): Promise<Map<string, string[]> | null> {
  modelsDevInputsPromise ??= fetchModelsDevInputs()
  return modelsDevInputsPromise
}

/**
 * 在 models.dev 里按模型名查视觉能力。精确 id 优先，其次 `org/模型名`
 * 后缀匹配；多个候选取多数派（平手视为支持）。查不到返回 undefined。
 */
async function lookupModelsDev(model: string): Promise<boolean | undefined> {
  const map = await getModelsDevInputs()
  if (!map) return undefined
  const lower = model.toLowerCase()
  const exact = map.get(lower)
  if (exact !== undefined) return exact.includes('image')
  let vision = 0
  let text = 0
  for (const [id, inputs] of map) {
    if (id.endsWith(`/${lower}`)) {
      if (inputs.includes('image')) vision++
      else text++
    }
  }
  if (vision === 0 && text === 0) return undefined
  return vision >= text
}

/**
 * 异步版 openAIModelSupportsImages：快路径之外再查 models.dev 的
 * modalities.input（含 'image' 即支持视觉）。查询失败/查不到时回退
 * 到快路径默认值，不抛错。
 */
export async function resolveOpenAIModelSupportsImages(
  model: string,
): Promise<boolean> {
  const fast = fastPathSupportsImages(model)
  if (fast !== undefined) return fast
  return (await lookupModelsDev(model)) ?? true
}

/** 仅供测试：重置 models.dev 缓存。 */
export function resetModelsDevCache(): void {
  modelsDevInputsPromise = null
}