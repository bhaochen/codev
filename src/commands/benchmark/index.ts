import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export const benchmark: Command = {
  type: 'local-jsx',
  name: 'benchmark',
  description: 'Run a deepsearch benchmark: ReAct search loop, trajectory scoring, context analysis',
  argumentHint: '[dataset] [--model X] [--judge-model Y] [--max-steps N] [--limit N] [--out DIR]',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./benchmark.js'),
}

export const benchmarkNonInteractive: Command = {
  type: 'local',
  name: 'benchmark',
  supportsNonInteractive: true,
  description: 'Run a deepsearch benchmark and print the report',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () => import('./benchmark-headless.js'),
}