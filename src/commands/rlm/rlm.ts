import type { LocalCommandCall } from '../../types/command.js'
import { rlmController } from '../../tools/RLMTool/controller.js'

export const call: LocalCommandCall = async (args, _context) => {
  const arg = args.trim()

  if (arg === '--stop' || arg === 'off') {
    rlmController.abort()
    return { type: 'text', value: 'RLM run aborted (if any); mode left as-is.' }
  }

  if (arg === 'on') {
    if (!rlmController.isEnabled()) rlmController.toggle()
    return {
      type: 'text',
      value: `RLM mode ${rlmController.isEnabled() ? 'ENABLED' : 'disabled'}.`,
    }
  }

  // Plain invocation toggles; state reports current status.
  const nowEnabled = rlmController.toggle()
  if (!nowEnabled) {
    return { type: 'text', value: 'RLM mode disabled. Normal mode restored.' }
  }
  return {
    type: 'text',
    value:
      'RLM mode enabled. The RLM tool is available for recursive decomposition; ' +
      'use /rlm again to disable.',
  }
}