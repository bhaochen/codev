/**
 * /rlm command — toggle RLM mode and show status.
 */
import type { Command } from '../../commands.js'

const rlm = {
  type: 'local',
  name: 'rlm',
  description: 'Toggle RLM (Recursive Language Model) mode',
  isEnabled: () => true,
  supportsNonInteractive: false,
  load: () => import('./rlm.js'),
} satisfies Command

export default rlm