import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'login',
  description:
    'Configure an OpenAI-compatible API endpoint (base URL + optional API key)',
  load: () => import('./login.js'),
} satisfies Command
