import { useMemo } from 'react'
import { getSdkBetas, getTotalInputTokens } from '../bootstrap/state.js'
import { useMainLoopModel } from './useMainLoopModel.js'
import {
  getContextWindowForModel,
  calculateContextPercentages,
} from '../utils/context.js'
import { getEffectiveContextWindowSize } from '../services/compact/autoCompact.js'

export interface ContextUsageInfo {
  currentTokens: number
  contextWindowTokens: number
  compactionTargetTokens: number
  utilizationPct: number
  hasData: boolean
}

export function useContextUsage(): ContextUsageInfo {
  const model = useMainLoopModel()

  const contextWindowTokens = getContextWindowForModel(
    model,
    getSdkBetas(),
  )

  const effectiveWindowSize = getEffectiveContextWindowSize(model)

  const totalInputTokens = getTotalInputTokens()

  const currentUsage = useMemo(() => {
    // We don't have per-call cache breakdown in global state,
    // so use total input tokens as approximation for current context usage.
    // This works because totalInputTokens tracks cumulative input,
    // but for a live progress bar we want the last API response's context size.
    // For now, use totalInputTokens as a reasonable proxy.
    return {
      input_tokens: totalInputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
  }, [totalInputTokens])

  const percentages = calculateContextPercentages(
    currentUsage,
    contextWindowTokens,
  )

  const utilizationPct = percentages.used ?? 0
  const hasData = percentages.used !== null

  // Compaction target is the threshold at which auto-compact triggers
  const compactionTargetTokens =
    effectiveWindowSize - 13_000 // AUTOCOMPACT_BUFFER_TOKENS

  return {
    currentTokens: totalInputTokens,
    contextWindowTokens,
    compactionTargetTokens,
    utilizationPct,
    hasData,
  }
}
