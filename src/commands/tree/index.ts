import type { Command } from '../../commands.js'

const tree: Command = {
  type: 'local-jsx',
  name: 'tree',
  description: 'Navigate the session fork tree (switch between branched sessions)',
  argumentHint: '[session id or search term]',
  load: () => import('./tree.js'),
}

export default tree
