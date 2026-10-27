import type { Command } from '../../commands.js'
import { saveCustomApiConfig, getCustomApiConfig } from '../../utils/auth.js'
import { getCustomBaseUrl, isCustomConfigured } from '../../utils/model/providers.js'

export default {
  type: 'local-jsx',
  name: 'login',
  description: 'Configure API provider (9router, OpenRouter, Local, Custom OpenAI-compatible, etc.)',
  load: () => import('./login.js'),
} satisfies Command
