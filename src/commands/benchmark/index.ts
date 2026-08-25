import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export const benchmark: Command = {
  type: 'local-jsx',
  name: 'benchmark',
  description:
    '/benchmark 雷达图：模型维度对比（显示命令）。用法：/benchmark（显示已保存雷达图） | /benchmark eval [dataset] [--model X] ...（测试当前模型并保存维度图） | /benchmark clear（清除历史）',
  argumentHint: '[eval | show | clear]',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./benchmark.js'),
}

export const benchmarkNonInteractive: Command = {
  type: 'local',
  name: 'benchmark',
  supportsNonInteractive: true,
  description:
    '/benchmark 雷达图（headless）：默认显示已保存雷达图，benchmark eval 测试并保存，benchmark clear 清除历史',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () => import('./benchmark-headless.js'),
}