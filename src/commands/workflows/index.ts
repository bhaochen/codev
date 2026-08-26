import type { Command, LocalCommandCall } from '../../types/command.js'

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const HELP = [
  '用法: /workflows <子命令>',
  '  list                 列出可用 workflow 与本会话的活动 run(默认)',
  '  start <name> [args]  启动 workflow;args 文本进入 input.task,--input-json {} 合并额外字段',
  '  status               当前 run 快照',
  '  pause | resume | cancel   控制 run',
  '  answer <json>        回答 checkpoint',
].join('\n')

export const call: LocalCommandCall = async (rawArgs, context) => {
  const { getWorkflowRuntime } = await import('../../workflows/runtime.js')
  const runtime = getWorkflowRuntime()
  // 惰性恢复:认领本会话遗留的 ACTIVE run(幂等)。
  try {
    await runtime.recover()
  } catch {
    // 无可恢复 run 时静默
  }
  const recovered = runtime.getStatus()
  if (recovered) {
    const { trackWorkflowRun } = await import(
      '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
    )
    trackWorkflowRun(context.setAppState, recovered)
  }

  const trimmed = rawArgs.trim()
  if (!trimmed || trimmed === 'help' || trimmed === '--help') {
    return { type: 'text', value: HELP }
  }
  const spaceIdx = trimmed.indexOf(' ')
  const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

  try {
    switch (sub) {
      case 'list': {
        const runs = await runtime.listStoredRuns({
          statuses: ['running', 'paused', 'waiting'],
        })
        const { discoverWorkflows } = await import('../../workflows/loader.js')
        const discovered = await discoverWorkflows()
        const lines: string[] = []
        if (discovered.workflows.length === 0) {
          lines.push(
            '未发现 workflow。放置文件到 .claude/workflows/*.workflow.ts 或 ~/.claude/workflows/。',
          )
        } else {
          lines.push('workflows:')
          for (const wf of discovered.workflows) {
            lines.push('  ' + wf.name + '  (' + wf.scope + ')')
          }
        }
        for (const err of discovered.errors) {
          lines.push('  加载失败: ' + err.path + ': ' + err.message)
        }
        if (runs.length === 0) {
          lines.push('活动 run: 无')
        } else {
          lines.push('活动 run (' + runs.length + '):')
          for (const run of runs) {
            lines.push('  ' + run.id + '  ' + run.workflowName + '  ' + run.status)
          }
        }
        return { type: 'text', value: lines.join('\n') }
      }
      case 'start': {
        if (!rest) return { type: 'text', value: HELP }
        const nameEnd = rest.indexOf(' ')
        const name = nameEnd === -1 ? rest : rest.slice(0, nameEnd)
        const argText = nameEnd === -1 ? '' : rest.slice(nameEnd + 1).trim()
        const { parseStartArgs } = await import(
          '../../tools/WorkflowTool/createWorkflowCommand.js'
        )
        const input = parseStartArgs(argText)
        const message = await runtime.start(name, input)
        const status = runtime.getStatus()
        if (status) {
          const { trackWorkflowRun } = await import(
            '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
          )
          trackWorkflowRun(context.setAppState, status)
        }
        return { type: 'text', value: message }
      }
      case 'status':
        return {
          type: 'text',
          value: text(runtime.getStatus()) || '没有本会话的活动 run',
        }
      case 'pause':
        return { type: 'text', value: text(await runtime.requestPause()) }
      case 'resume':
        return { type: 'text', value: text(await runtime.resume()) }
      case 'cancel':
        return { type: 'text', value: text(await runtime.cancel()) }
      case 'answer': {
        if (!rest) {
          return {
            type: 'text',
            value: '用法: /workflows answer <json>(如 {"ok":true})',
          }
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(rest)
        } catch (error) {
          return {
            type: 'text',
            value:
              'answer 需要 JSON: ' +
              (error instanceof Error ? error.message : String(error)),
          }
        }
        return { type: 'text', value: text(await runtime.answer(parsed)) }
      }
      default:
        return {
          type: 'text',
          value: '未知子命令 "' + sub + '"。\n' + HELP,
        }
    }
  } catch (error) {
    return {
      type: 'text',
      value:
        'workflow 错误: ' +
        (error instanceof Error ? error.message : String(error)),
    }
  }
}

const workflows = {
  type: 'local',
  name: 'workflows',
  aliases: ['workflow'],
  description: '管理多步工作流:list/start/pause/resume/cancel/answer',
  argumentHint: '[list|start|status|pause|resume|cancel|answer] ...',
  supportsNonInteractive: true,
  load: async () => ({ call }),
} satisfies Command

export default workflows
