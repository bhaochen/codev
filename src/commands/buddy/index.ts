import type { Command } from '../../commands.js'

const buddy = {
  type: 'local',
  name: 'buddy',
  description: 'Hatch and manage your companion',
  supportsNonInteractive: false,
  argumentHint:
    '[status|hatch [name]|pet|rename <name>|bio <text>|mute|unmute|dismiss|reset]',
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
