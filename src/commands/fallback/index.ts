import type { Command } from '../../commands.js'

export default {
  name: 'fallback',
  description: 'Choose fallback providers and models in an interactive panel',
  type: 'local-jsx',
  argumentHint: '[add|remove|clear|on|off] ...',
  load: () => import('./fallback.js'),
} satisfies Command
