import * as React from 'react'
import { useState } from 'react'
import { randomUUID, type UUID } from 'node:crypto'
import figures from 'figures'
import { Box, Text, useInput } from '../../ink.js'
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
import { loadComparisonSeries } from './radar.js'

/**
 * /benchmark —— 交互式 UI（配置面板 + 对话区注入）。
 *
 * 这块 JSX 区域是 benchmark 的「配置面板」：数据集 / agent 模型 /
 * LLM-as-judge 模型 / max-steps / limit / judge / score。
 * 按 ▶ RUN 后面板关闭，运行进度与最终报告（指标、表格、context 折线图、
 * LongSeeker 建议）通过 context.setMessages 直接注入对话框 transcript。
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  return (
    <BenchmarkConfigPanel
      onClose={onDone}
      setMessages={context.setMessages}
      initial={parseBenchmarkArgs(args)}
    />
  )
}

type FieldKey =
  | 'dataset'
  | 'model'
  | 'judgeModel'
  | 'maxSteps'
  | 'limit'
  | 'judge'
  | 'score'
  | 'compare'
  | 'run'

const FIELD_ORDER: FieldKey[] = [
  'dataset',
  'model',
  'judgeModel',
  'maxSteps',
  'limit',
  'judge',
  'score',
  'compare',
  'run',
]

const FIELD_META: Record<
  FieldKey,
  { label: string; hint?: string; kind: 'text' | 'number' | 'toggle' | 'run' }
> = {
  dataset: {
    label: 'dataset',
    hint: 'builtin: deepsearch-demo · or path/to/dataset.json',
    kind: 'text',
  },
  model: {
    label: 'agent model',
    hint: 'ReAct search loop',
    kind: 'text',
  },
  judgeModel: {
    label: 'judge model',
    hint: 'LLM-as-judge + step scoring · blank = agent',
    kind: 'text',
  },
  maxSteps: { label: 'max steps', hint: 'per question', kind: 'number' },
  limit: { label: 'limit', hint: '0 = all questions', kind: 'number' },
  judge: { label: 'llm-as-judge', hint: 'OpenSeeker eval', kind: 'toggle' },
  score: { label: 'step scoring', hint: 'ABSeeker per-step', kind: 'toggle' },
  compare: {
    label: 'compare',
    hint: 'overlay previous runs as radar polygons',
    kind: 'toggle',
  },
  run: { label: '▶ RUN', hint: 'enter to start', kind: 'run' },
}

type PanelValues = {
  dataset: string
  model: string
  judgeModel: string
  maxSteps: string
  limit: string
  judge: boolean
  score: boolean
  compare: boolean
}

type Props = {
  onClose: LocalJSXCommandOnDone
  setMessages: LocalJSXCommandContext['setMessages']
  initial: BenchmarkArgs
}

export function BenchmarkConfigPanel({ onClose, setMessages, initial }: Props) {
  const [values, setValues] = useState<PanelValues>(() => ({
    dataset: initial.dataset,
    model: initial.model,
    judgeModel: initial.judgeModel,
    maxSteps: String(initial.maxSteps),
    limit: initial.limit === Infinity ? '0' : String(initial.limit),
    judge: initial.judge,
    score: initial.score,
    compare: initial.compare > 0,
  }))
  const [focus, setFocus] = useState(0)

  const setField = (k: FieldKey, v: string | boolean) =>
    setValues(prev => ({ ...prev, [k]: v }))

  const start = () => {
    const maxSteps = Math.max(1, parseInt(values.maxSteps, 10) || 8)
    const limitRaw = parseInt(values.limit, 10)
    const args: BenchmarkArgs = {
      dataset: values.dataset.trim() || 'deepsearch-demo',
      model: values.model.trim() || getMainLoopModel(),
      judgeModel: values.judgeModel.trim(),
      maxSteps,
      limit: Number.isNaN(limitRaw) || limitRaw <= 0 ? Infinity : limitRaw,
      out: '',
      judge: values.judge,
      score: values.score,
      compare: values.compare ? 4 : 0,
    }
    // 关掉配置面板（跳过 REPL 默认的 transcript 注入，我们自己注入）
    onClose(undefined, { display: 'skip' })
    runBenchmarkToTranscript(setMessages, args)
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === 'c' || input === 'd'))) {
      onClose(undefined, { display: 'skip' })
      return
    }
    const field = FIELD_ORDER[focus]!
    if (key.upArrow) {
      setFocus((focus - 1 + FIELD_ORDER.length) % FIELD_ORDER.length)
      return
    }
    if (key.downArrow || key.tab) {
      setFocus((focus + 1) % FIELD_ORDER.length)
      return
    }
    if (field === 'run') {
      if (key.return || input === ' ') start()
      return
    }
    if (key.return) {
      if (field === 'judge' || field === 'score') setField(field, !values[field])
      setFocus((focus + 1) % FIELD_ORDER.length)
      return
    }
    if (field === 'judge' || field === 'score') {
      if (input === ' ') setField(field, !values[field])
      return
    }
    // text / number 字段
    if (key.backspace) {
      setField(field, String(values[field]).slice(0, -1))
      return
    }
    if (input && !key.ctrl && !key.meta) {
      if (field === 'maxSteps' || field === 'limit') {
        if (/^\d$/.test(input)) setField(field, String(values[field]) + input)
      } else {
        setField(field, String(values[field]) + input)
      }
    }
  })

  const f = FIELD_ORDER[focus]!

  return (
    <Box flexDirection="column" paddingX={1} width={64}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>/benchmark · deepsearch benchmark config</Text>
        <Text color="subtle">
          ReAct search loop (OpenSeeker) + LLM-as-judge + ABSeeker step scoring
          + LongSeeker context analysis
        </Text>
      </Box>

      <Box flexDirection="column">
        {FIELD_ORDER.map((k, i) => {
          const meta = FIELD_META[k]!
          const selected = i === focus
          return (
            <Box key={k} flexDirection="column" marginBottom={selected ? 0 : 1}>
              <Box>
                <Box width={14}><Text color="subtle">{meta.label}</Text></Box>
                {meta.kind === 'toggle' ? (
                  <Text bold={selected}>
                    [{' '}
                    <Text color={values[k] ? 'success' : 'subtle'}>
                      {values[k] ? 'x' : ' '}
                    </Text>{' '}
                    ]
                  </Text>
                ) : (
                  <Text
                    bold={selected}
                    color={selected && meta.kind !== 'run' ? 'accent' : undefined}
                    wrap="truncate"
                  >
                    {meta.kind === 'run'
                      ? meta.label
                      : String(values[k]) || '(empty)'}
                  </Text>
                )}
              </Box>
              {selected && meta.hint && (
                <Text color="subtle" dimColor marginLeft={14}>
                  {meta.hint}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>

      <Box marginTop={1}>
        <Text color="subtle" dimColor>
          {figures.arrowUp}/{figures.arrowDown} move · type to edit · space
          toggle · enter {f === 'run' ? 'run' : 'next'} · esc close
        </Text>
      </Box>
    </Box>
  )
}

/**
 * 面板关闭后：把运行注入对话框 transcript。
 * header 一条静态消息 + 一条随 onProgress 原地替换的 live 消息，
 * 结束时 live 替换为 deepsearch 工具的 tool result 消息对
 * （assistant tool_use + user tool_result），报告以工具结果样式展示，
 * 主 agent 也能以 tool result 形式读到完整报告。
 */

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
