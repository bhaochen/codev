import type { ProviderContext, ProviderId } from '../types.js'
import { getAPIProvider } from '../../../utils/model/providers.js'

export function resolveProviderContext(): ProviderContext {
  const raw = getAPIProvider()
  // getAPIProvider 已按 env > SDK flag > config > default 解析，最新默认 opencode
  const provider = (raw ?? 'opencode') as ProviderId
  // source 粗分：env 覆盖 vs 配置 vs 默认，足够用于审计，无需细粒度
  const source: ProviderContext['source'] =
    process.env.CLAUDE_CODE_API_PROVIDER || process.env.BETTER_CLAWD_API_PROVIDER
      ? 'env'
      : process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX
        ? 'sdk-flag'
        : 'config'
  return { provider, source }
}
