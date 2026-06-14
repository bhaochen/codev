import type { Command } from '../../commands.js'

const feishu = {
  type: 'local-jsx',
  name: 'feishu',
  description: 'Connect a Feishu bot to this session',
  load: () => import('./feishu.js'),
} satisfies Command

export default feishu