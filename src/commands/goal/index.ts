import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description:
    'Set or manage long-running autonomous goals. Supports multiple goals with a focused one that auto-continues. Subcommands: set/add <objective>, list, focus <id>, pause, resume, edit <objective>, clear.',
  argumentHint: '[set|add <objective>|list|focus <id>|pause|resume|edit <objective>|clear]',
  load: () => import('./goal.js'),
} satisfies Command

export default goal