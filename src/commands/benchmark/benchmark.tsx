import * as React from 'react'
import { randomUUID, type UUID } from 'node:crypto'
import { useEffect, useState } from 'react'
import figures from 'figures'
import { Ansi, Box, Text, useInput } from '../../ink.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import {
  createAssistantMessage,
  createCommandInputMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import {
  parseBenchmarkArgs,
  runBenchmark,
  type BenchmarkArgs,
} from './runner.js'
import { buildInlineReport, buildLiveProgressText } from './report.js'
import {
  RADAR_AXES,
  RADAR_PALETTE_INK,
  clearHistory,
  loadComparisonSeries,
  loadSavedProfiles,
  renderRadarAxisTable,
  renderRadarChart,
  type RadarSeries,
} from './radar.js'

/**
 * /benchmark —— 雷达图驱动的 benchmark 命令。
 *
 * 子命令：
 *   /benchmark           直接显示已保存的雷达图（各模型一条彩色线）
 *   /benchmark eval     对当前模型跑 benchmark 并把维度图存入历史
 *   /benchmark clear    清空所有历史
 *
 * 参考 Kiln compare_radar_chart：每轴一个评测维度，每个多边形一次 run，
 * 不同模型用不同颜色区分。交互式展示走 Ink <Ansi> 上色；注入 transcript 的
 * 文本报告保持无颜色（用不同字符区分线），以兼容文本渲染路径。
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const sp = args.trim().split(/\s+/).filter(Boolean)
  const sub = (sp[0] ?? '').toLowerCase()
  if (sub === 'clear') return <BenchmarkClearView onClose={onDone} />
  if (sub === 'eval') {
    const parsed = parseBenchmarkArgs(sp.slice(1).join(' '))
    // 关掉命令 UI（跳过 REPL 默认的 transcript 注入，由 runBenchmarkToTranscript 自行注入）
    onDone(undefined, { display: 'skip' })
    runBenchmarkToTranscript(context.setMessages, parsed)
    return <Box />
  }
  return <BenchmarkRadarView onClose={onDone} />
}

/**
 * 直接展示雷达图：加载所有已保存的模型 profile，用彩色线叠加渲染。
 */
function BenchmarkRadarView({ onClose }: { onClose: LocalJSXCommandOnDone }) {
  const [profiles, setProfiles] = useState<RadarSeries[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    loadSavedProfiles()
      .then(setProfiles)
      .catch(e => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  useInput(() => onClose())

  if (err) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color="red">radar error: {err}</Text>
      </Box>
    )
  }
  if (!profiles) {
    return (
      <Box paddingX={1}>
        <Text color="subtle">loading radar…</Text>
      </Box>
    )
  }
  if (profiles.length === 0) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text bold>/benchmark · radar</Text>
        <Text color="subtle">
          no saved profiles yet — run <Text color="accent">/benchmark eval</Text> to add one
        </Text>
        <Text color="subtle" dimColor>
          press any key to close
        </Text>
      </Box>
    )
  }
  return <RadarView series={profiles} onClose={onClose} />
}

/** 彩色雷达图 + 图例 + 每轴数值表 */
function RadarView({
  series,
  onClose,
}: {
  series: RadarSeries[]
  onClose: LocalJSXCommandOnDone
}) {
  const colored = renderRadarChart(RADAR_AXES, series, { colorize: true })
  useInput(() => onClose())
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        /benchmark · radar — {series.length} model profile{series.length > 1 ? 's' : ''}
      </Text>
      <Ansi>{colored}</Ansi>
      <Box flexDirection="column" marginTop={1}>
        {series.map((s, i) => (
          <Text
            key={i}
            color={RADAR_PALETTE_INK[i % RADAR_PALETTE_INK.length]!}
          >
            ● {truncate(s.name, 44)}
          </Text>
        ))}
      </Box>
      <Text color="subtle" marginTop={1}>
        {renderRadarAxisTable(RADAR_AXES, series)}
      </Text>
      <Text color="subtle" dimColor marginTop={1}>
        press any key to close
      </Text>
    </Box>
  )
}

/** /benchmark clear：清空历史 */
function BenchmarkClearView({ onClose }: { onClose: LocalJSXCommandOnDone }) {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    clearHistory()
      .then(n => setMsg(`cleared ${n} saved benchmark profile${n === 1 ? '' : 's'}`))
      .catch(e => setMsg(`clear failed: ${e instanceof Error ? e.message : String(e)}`))
  }, [])
  useInput(() => {
    if (msg) onClose()
  })
  return (
    <Box paddingX={1}>
      <Text color="subtle">{msg ?? 'clearing history…'}</Text>
    </Box>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * 构造最终报告的 tool result 消息对。assistant 的 tool_use 与 user 的
 * tool_result 通过同一 tool_use_id 配对，UI 渲染为一次 DeepSearch 工具
 * 调用及其结果。纯函数便于单元测试。
 */
export function buildReportToolResultMessages(
  args: Pick<
    BenchmarkArgs,
    'dataset' | 'model' | 'judgeModel' | 'maxSteps' | 'limit'
  >,
  report: string,
): { toolUseId: string; assistant: AssistantMessage; user: UserMessage } {
  const toolUseId = `toolu_${randomUUID().replaceAll('-', '')}`
  const assistant = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'deepsearch',
        input: {
          dataset: args.dataset,
          model: args.model,
          ...(args.judgeModel && args.judgeModel !== args.model
            ? { judgeModel: args.judgeModel }
            : {}),
          maxSteps: args.maxSteps,
          ...(Number.isFinite(args.limit) ? { limit: args.limit } : {}),
        },
      },
    ],
  })
  const user = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: report }],
      },
    ],
    sourceToolAssistantUUID: assistant.uuid as UUID,
  })
  return { toolUseId, assistant, user }
}

function runBenchmarkToTranscript(
  setMessages: LocalJSXCommandContext['setMessages'],
  args: BenchmarkArgs,
): void {
  const header = createCommandInputMessage(`🔬 /benchmark · ${args.dataset}`)
  const live = createCommandInputMessage(
    buildLiveProgressText({
      phase: 'loading',
      datasetName: args.dataset,
      total: 0,
      current: 0,
      currentId: '',
      currentQuery: '',
      currentSteps: 0,
      currentCtxTokens: 0,
      currentAction: '',
      message: `model=${args.model}${args.judgeModel ? ` judge=${args.judgeModel}` : ''}, max-steps=${args.maxSteps}`,
    }),
  )
  const liveUuid = live.uuid
  setMessages(prev => [
    ...prev,
    header as unknown as Message,
    live as unknown as Message,
  ])

  const patchLive = (content: string) => {
    setMessages(prev =>
      prev.map(m =>
        m.uuid === liveUuid
          ? ({
              type: 'system',
              subtype: 'local_command',
              content,
              level: 'info',
              timestamp: m.timestamp,
              uuid: m.uuid,
              isMeta: false,
            } as unknown as Message)
          : m,
      ),
    )
  }

  // 结束时把 live 进度消息替换为 tool result 消息对（报告以工具结果展示）
  const finishWithReport = (report: string) => {
    const { assistant, user } = buildReportToolResultMessages(args, report)
    setMessages(prev => [
      ...prev.filter(m => m.uuid !== liveUuid),
      assistant as unknown as Message,
      user as unknown as Message,
    ])
  }

  runBenchmark({
    args,
    onProgress: p => {
      patchLive(
        buildLiveProgressText({
          phase: p.phase,
          datasetName: p.datasetName,
          total: p.total,
          current: p.current,
          currentId: p.currentId,
          currentQuery: p.currentQuery,
          currentSteps: p.currentSteps,
          currentCtxTokens: p.currentCtxTokens,
          currentAction: p.currentAction,
          message: p.message,
        }),
      )
    },
  })
    .then(async run => {
      const compare =
        args.compare > 0
          ? await loadComparisonSeries(run, args.compare).catch(() => [])
          : []
      finishWithReport(buildInlineReport(run, { compare }))
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      patchLive(`✘ /benchmark failed: ${msg}`)
    })
}
