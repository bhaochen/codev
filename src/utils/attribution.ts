export type AttributionTexts = {
  commit: string
  pr: string
}

export function getAttributionTexts(): AttributionTexts {
  return { commit: '', pr: '' }
}

export async function getEnhancedPRAttribution(): Promise<string> {
  return ''
}
