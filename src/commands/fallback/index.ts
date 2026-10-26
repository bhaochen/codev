import type { Command } from '../../commands.js'

export default {
  name: 'fallback',
  description: 'Choose 9router models for automatic fallback',
  type: 'local-jsx',
  argumentHint: '[add|remove|clear|on|off] ...',
  load: () => import('./fallback.js'),
} satisfies Command
