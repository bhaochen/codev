// LLM usage helpers — re-exported from canonical protocol client
// New home for accumulateUsage / updateUsage previously in src/services/api/claude.ts
export {
  accumulateUsage,
  updateUsage,
} from '../clients/anthropicMessages.js'
export type { NonNullableUsage } from '../../api/logging.js'
export { EMPTY_USAGE } from '../../api/emptyUsage.js'
