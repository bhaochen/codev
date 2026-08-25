import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export const benchmark: Command = {
  type: 'local-jsx',
  name: 'benchmark',
  description:
    '/benchmark 雷达图：对当前模型跑 benchmark 并保存维度图（默认）。用法：/benchmark [dataset] [--model X] ...（测试并保存） | /benchmark show（显示已保存雷达图） | /benchmark clear（清除历史）',
  argumentHint: '[dataset] [--model X] [--judge-model Y] [--max-steps N] [--limit N] | show | clear]',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./benchmark.js'),
}

export const benchmarkNonInteractive: Command = {
  type: 'local',
  name: 'benchmark',
  supportsNonInteractive: true,
  description:
    '/benchmark 雷达图（headless）：默认跑 benchmark 并保存，/benchmark show 显示已保存雷达图，/benchmark clear 清除历史',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () => import('./benchmark-headless.js'),
}