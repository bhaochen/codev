import type { Command } from '../../commands.js'

const friend = {
  type: 'local-jsx',
  name: 'friend',
  description: 'Manage the VRM desktop pet companion — start/stop the 3D avatar window and adjust settings',
  aliases: ['vrm'],
  load: () => import('./friend.js'),
} satisfies Command

export default friend
